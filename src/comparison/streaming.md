# Real-World Scenario: Streaming Data Processing

**Scenario:** Processing large datasets (log files, CSV imports, event streams) with Result-aware transformations.
**Key Constraints:** Memory efficiency, backpressure handling, error propagation through streams.

See the code: `streaming.test.ts`

## The Approaches

### 1. Manual Implementation (Vanilla/Neverthrow)

Without built-in streaming support, you need to implement your own:

```typescript
import { ok, err, Result } from 'neverthrow';

async function* processLines(
  lines: AsyncIterable<string>
): AsyncGenerator<Result<ProcessedLine, ProcessError>> {
  for await (const line of lines) {
    const parsed = parseLine(line);
    if (parsed.isErr()) {
      yield err(parsed.error);
      continue;
    }

    const validated = validateLine(parsed.value);
    if (validated.isErr()) {
      yield err(validated.error);
      continue;
    }

    yield ok(validated.value);
  }
}

// Manual backpressure handling
async function processWithBackpressure(
  source: AsyncIterable<string>,
  sink: WritableStream<ProcessedLine>,
  options: { highWaterMark: number }
) {
  const writer = sink.getWriter();
  let pending = 0;

  for await (const result of processLines(source)) {
    if (result.isErr()) {
      console.error('Processing error:', result.error);
      continue;
    }

    pending++;
    if (pending >= options.highWaterMark) {
      await writer.ready;
      pending = 0;
    }

    await writer.write(result.value);
  }

  await writer.close();
}
```

**Pros:**
- Full control over implementation
- No additional dependencies

**Cons:**
- Significant boilerplate
- Easy to get backpressure wrong
- No standard transformer composition

### 2. Effect Stream

Effect provides powerful stream processing:

```typescript
import { Stream, Effect, Chunk } from 'effect';

const processLines = Stream.fromAsyncIterable(
  readLines(file),
  () => new ReadError('Failed to read')
).pipe(
  Stream.mapEffect((line) =>
    Effect.gen(function* () {
      const parsed = yield* parseLine(line);
      const validated = yield* validateLine(parsed);
      return validated;
    })
  ),
  Stream.catchAll((error) =>
    Stream.succeed({ error, skipped: true })
  ),
  Stream.grouped(100), // Batch into chunks of 100
  Stream.mapEffect((chunk) =>
    Effect.forEach(Chunk.toReadonlyArray(chunk), (item) =>
      saveToDatabase(item)
    )
  )
);

// Run with automatic backpressure
await Effect.runPromise(
  Stream.runDrain(processLines)
);
```

**Pros:**
- Powerful composition operators
- Built-in backpressure and concurrency control
- Error handling integrated with Effect ecosystem
- Windowing, merging, and complex stream operations

**Cons:**
- Requires learning Effect paradigm
- Heavy bundle size
- May be overkill for simple use cases

### 3. Awaitly Streaming (Awaitly 4)

*This scenario uses `awaitly/durable` with durable workflows for backpressure and resume. For typed Results without workflows, see [api-comparison.md §1–2](./api-comparison.md).*

`awaitly/durable` provides Result-aware stream transformers with familiar APIs:

```typescript
import { createWorkflow } from 'awaitly';
import {
  createMemoryStreamStore,
  pipe,
  map,
  filter,
  chunk,
} from 'awaitly/durable';

// The stream store is a workflow option; step.getReadable/getWritable read it
const streamStore = createMemoryStreamStore();

const job = createWorkflow('streamJob', { parseLine, validateLine, saveBatch }, {
  streamStore,
});

const result = await job.run(async ({ step, deps }) => {
  const reader = step.getReadable<string>({ namespace: 'input' });

  // Transformers are data-first functions over an AsyncIterable, composed with
  // pipe() — not Web Streams TransformStreams
  const batches = pipe(
    reader,
    (s) => map(s, (line) => line.trim()),
    (s) => filter(s, (line) => line.length > 0),
    (s) => chunk(s, 100) // Batch for efficient writes
  );

  // Consume with for-await; backpressure comes from the reader's highWaterMark
  let totalProcessed = 0;
  for await (const batch of batches) {
    await step('saveBatch', () => deps.saveBatch(batch), {
      key: `batch:${totalProcessed}`,
    });
    totalProcessed += batch.length;
  }

  return { totalProcessed };
});
```

**Pros:**
- Plain async iterables — `for await` works, no TransformStream plumbing
- Result-aware transformers
- Automatic backpressure
- Integrates with workflow caching/resume
- Simpler than Effect for common cases

**Cons:**
- Less powerful than Effect Stream (no windowing)
- Newer API, less battle-tested
- Limited stream merging/splitting

## Transformer Reference

Every transformer is data-first: it takes the source (a `StreamReader` or any `AsyncIterable`) as its first argument and returns an `AsyncIterable`, so `pipe(source, ...stages)` composes them and `for await` consumes them.

| Transformer | Description | Example |
|-------------|-------------|---------|
| `map(source, fn)` | Transform each item | `map(s, (x) => x * 2)` |
| `filter(source, predicate)` | Keep items matching predicate | `filter(s, (x) => x > 0)` |
| `flatMap(source, fn)` | One-to-many transformation | `flatMap(s, (x) => x.split(','))` |
| `mapAsync(source, fn)` | Async transform, yields `Result` per item | `mapAsync(s, enrich)` |
| `chunk(source, size)` | Batch items into arrays | `chunk(s, 100)` |
| `take(source, n)` / `skip(source, n)` | Limit or skip items | `take(s, 1000)` |
| `takeWhile` / `skipWhile` | Limit or skip by predicate | `takeWhile(s, (x) => x.ok)` |
| `collect(source)` | Gather all items into an array (`Promise<T[]>`) | `await collect(processed)` |
| `reduce(source, fn, init)` | Reduce to a single value | `reduce(s, (acc, x) => acc + x, 0)` |
| `pipe(source, ...stages)` | Compose the stages above | see example |

`collect` and `reduce` return plain promises, not Results: they are terminal consumers of an async iterable, and returning a Result would make every caller unwrap one just to get an array.

You do not lose typed errors by that choice. Since Awaitly 4.1 the two ways they can fail are sorted at the workflow boundary — a stream failure (`STREAM_READ_ERROR` and friends) arrives as a typed value like `STEP_TIMEOUT` does, while a throw from your own transform callback stays an `UnexpectedError` with the original on `.cause`. Declare it (`errors: ['STREAM_READ_ERROR']`) to put it in the static union; wrap with `step.try` only when you want your own callback throws typed too.

## Backpressure Handling

```typescript
import { createBackpressureController, shouldApplyBackpressure } from 'awaitly/durable';

const controller = createBackpressureController({
  highWaterMark: 1000,
  onStateChange: (state) => metrics.increment(`backpressure.${state}`),
});

for (const item of hugeDataset) {
  if (shouldApplyBackpressure(controller)) {
    await controller.waitForDrain();
  }
  await writable.write(item);
}
```

## Comparison Table

| Feature | Manual | Effect Stream | Awaitly Streaming |
|---------|--------|---------------|-------------------|
| **API Style** | Custom | Functional operators | Data-first fns over async iterables |
| **Learning Curve** | High (custom impl) | High (Effect) | Low (familiar APIs) |
| **Backpressure** | Manual | Automatic | Automatic |
| **Error Handling** | Manual | Effect errors | Result types |
| **Windowing** | Manual | Built-in | Not supported |
| **Merging/Splitting** | Manual | Built-in | Limited |
| **Workflow Integration** | Manual | Custom | Built-in |
| **Resume Support** | Manual | Custom | Built-in |
| **Bundle Size** | None | Large | Small |

## Conclusion

For **Streaming Data Processing**:
- **Awaitly Streaming** is ideal for common use cases: log processing, CSV imports, event streams. Plain async iterables, Result-aware, integrates with workflow resume.
- **Effect Stream** is more powerful for complex scenarios: windowing, stream merging, sophisticated backpressure. Worth it if you're already using Effect.
- **Manual Implementation** is only recommended if you have very specific requirements that neither library covers.

### Honest Assessment

**Awaitly Streaming Strengths:**
- Much simpler than Effect for common streaming patterns
- Result-aware transformers eliminate manual error checking
- Web Streams API is already familiar to many developers
- Workflow integration means streams can be resumed

**Awaitly Streaming Limitations:**
- No windowing (time-based or count-based with overlap)
- No sophisticated backpressure strategies (just high-water mark)
- No stream merging/splitting operators
- Less mature than Effect Stream
