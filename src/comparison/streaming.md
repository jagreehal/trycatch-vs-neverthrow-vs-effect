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

### 3. Awaitly Streaming (v1.11.0)

`awaitly/streaming` provides Result-aware stream transformers with familiar APIs:

```typescript
import {
  createMemoryStreamStore,
  createFileStreamStore,
  map,
  filter,
  flatMap,
  chunk,
  take,
  skip,
  collect,
  reduce,
} from 'awaitly/streaming';
import { durable } from 'awaitly/durable';

const store = createMemoryStreamStore<string>();

const result = await durable.run(
  { parseLine, validateLine, saveBatch },
  async ({ step, deps }) => {
    // Get readable stream
    const readable = await step.getReadable(store, { key: 'input' });

    // Transform pipeline (Result-aware)
    const processed = readable
      .pipeThrough(map((line) => deps.parseLine(line)))
      .pipeThrough(filter((result) => result.ok))
      .pipeThrough(map((result) => deps.validateLine(result.value)))
      .pipeThrough(filter((result) => result.ok))
      .pipeThrough(chunk(100)); // Batch for efficient writes

    // Process batches with automatic backpressure
    let totalProcessed = 0;
    for await (const batch of processed) {
      const saved = await step('saveBatch', () => deps.saveBatch(batch), {
        key: `batch:${totalProcessed}`,
      });
      totalProcessed += batch.length;
    }

    return { totalProcessed };
  },
  { id: `stream-job-${jobId}`, store: persistenceStore }
);
```

**Pros:**
- Familiar Web Streams API
- Result-aware transformers
- Automatic backpressure
- Integrates with workflow caching/resume
- Simpler than Effect for common cases

**Cons:**
- Less powerful than Effect Stream (no windowing)
- Newer API, less battle-tested
- Limited stream merging/splitting

## Transformer Reference

| Transformer | Description | Example |
|-------------|-------------|---------|
| `map(fn)` | Transform each item | `map((x) => ok(x * 2))` |
| `filter(predicate)` | Keep items matching predicate | `filter((x) => x > 0)` |
| `flatMap(fn)` | One-to-many transformation | `flatMap((x) => ok(x.split(',')))` |
| `chunk(size)` | Batch items into arrays | `chunk(100)` |
| `take(n)` | Limit to first n items | `take(1000)` |
| `skip(n)` | Skip first n items | `skip(10)` |
| `collect` | Gather all items into array | `await step('collect', () => collect(stream))` |
| `reduce(fn, init)` | Reduce to single value | `reduce((acc, x) => acc + x, 0)` |

## Backpressure Handling

```typescript
import { createBackpressuredWriter } from 'awaitly/streaming';

const writer = createBackpressuredWriter(writable, {
  highWaterMark: 1000,
  onBackpressure: () => metrics.increment('backpressure'),
  onDrain: () => metrics.increment('drain'),
});

// Automatically pauses when buffer is full
for (const item of hugeDataset) {
  await writer.write(item);
}
await writer.close();
```

## Comparison Table

| Feature | Manual | Effect Stream | Awaitly Streaming |
|---------|--------|---------------|-------------------|
| **API Style** | Custom | Functional operators | Web Streams + helpers |
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
- **Awaitly Streaming** is ideal for common use cases: log processing, CSV imports, event streams. Familiar APIs, Result-aware, integrates with workflow resume.
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
