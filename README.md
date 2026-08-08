# Beyond Railway-Oriented Programming: Four Practical Error-Handling Styles

**Or: How I learned to stop worrying and embrace failure**

Here's the thing about software: it fails. Not sometimes. **Always**.

The database decides to take a nap right when you need it. The payment provider goes for a coffee break. The user types "banana" where you expected a number.

Most programmers treat errors like embarrassing relatives: they pretend they don't exist until they show up drunk at the family reunion and ruin everything.

But what if we treated errors as first-class citizens? What if failure was just another path through our code, not a derailment?

## The Problem: Building a Payment System That Won't Bankrupt You

Let's say you're building a payment system. Not a toy one: a real one that handles actual money and can't afford to lose a penny or charge someone twice.

Each step in this system fails in its own special way. To handle them properly, we first need to classify them:

1.  **Domain Errors** (e.g., `ValidationError`): Invalid user input like `{amount: "banana"}`. These are expected and should be handled with clear feedback.
2.  **Concurrency Errors** (e.g., `IdempotencyConflict`): Mobile apps retrying 47 times and hitting race conditions. Requires locking or deduplication.
3.  **Dependency Errors** (e.g., `ProviderUnavailable`, `Timeout`): The external payment provider having a bad day. Usually requires retries or failover.
4.  **Infrastructure Errors** (e.g., `PersistError`, `DatabaseError`): Your own database failing. Often requires paging an engineer.
5.  **Unexpected Errors** (e.g., Bugs): The `undefined is not a function` special.

This is where our four approaches start to diverge. What you're really choosing isn't just a library; you're choosing whether your error handling is exception-based, explicit Result-based, or Result-based with orchestration and policies on top.

(In practice, some errors overlap categories: for example, a provider 4xx is a dependency error, but it's often treated as a domain-level "hard fail" in business logic.)

**The Goal: Three Criteria for Great Error Handling**

Whatever approach you choose, evaluate it against these three benchmarks:
1.  **Visible**: Can you see all the ways your code can fail just by looking at it?
2.  **Composable**: Do errors make it painful to combine functions together?
3.  **Honest**: Do your function signatures tell the truth about what might happen?

The trade-off is almost always local ergonomics vs consistency and visibility across the codebase.

```mermaid
graph TD
    A[Raw Payment Request] --> B[Validate Input]
    B -->|Valid| C[Check for Existing Payment]
    B -->|Invalid| X1[Domain: ValidationError]

    C -->|Found| D[Return Existing Payment ID]
    C -->|Not Found| E[Acquire Lock]

    E -->|Success| F[Call Payment Provider]
    E -->|Failed| X2[Concurrency: IdempotencyConflict]

    F -->|Success| G[Persist Payment]
    F -->|4xx Error| X3[Dependency: ProviderRejected 4xx]
    F -->|5xx/Timeout| H[Retry Logic]

    H -->|Retry Success| G
    H -->|All Retries Failed| I[Persist Failure Record]
    I --> X4[Dependency: ProviderUnavailable]

    G -->|Success| J[Return Payment ID]
    G -->|Failed| X5[Infrastructure: PersistError]

    style X1 fill:#ff9999
    style X2 fill:#ff9999
    style X3 fill:#ff9999
    style X4 fill:#ff9999
    style X5 fill:#ff9999
    style J fill:#99ff99
    style D fill:#99ff99
```

## At a Glance: Practical Comparison

All four approaches model the same payment workflow. In the repo, the implementations are exercised by a shared test suite.

| Approach | Error Visibility | Composability | Ergonomics | Streaming | Functional | Type-Safe Fetch | ESLint Plugin |
|----------|-----------------|---------------|------------|-----------|------------|-----------------|---------------|
| **Vanilla (try/catch)** | Low (hidden) | Medium (wraps) | High | Manual | Manual | Manual | - |
| **Neverthrow** | High | High | High (chains) | Manual | Manual | Manual | ✓ |
| **Effect** | Very High | Very High | Low → Medium | ✓ Stream | ✓ pipe/flow | ✓ HttpClient | ✓ |
| **Awaitly** | High | High | High (async/await) | ✓ Streaming | Result combinators | Native fetch + `tryAsync` | ✓ |

**Key Differentiators:**

- **Vanilla**: Simplest to write, but errors hide in function signatures.
- **Neverthrow**: Best for functional chaining and explicit error types.
- **Effect**: Most powerful ecosystem (DI, layers, scheduling, tracing, streams) but has a steep learning curve.
- **Awaitly**: Result library first (`ok`/`err`, same model as neverthrow). Workflows, caching, and policies are optional add-ons.

## Awaitly: Three Usage Levels

Awaitly stacks optional layers. You can stop at any one.

| Level | Import | When |
|-------|--------|------|
| Results only | `awaitly` or `awaitly/result` | Drop-in neverthrow alternative |
| Composition | Manual checks + `ErrorsOf`, or `run(deps, fn)` | Async sequential work without workflows |
| Orchestration | `createWorkflow`, `durable` | Caching, resume, HITL, policies |

```mermaid
flowchart TD
  L1["Level1: ok/err + AsyncResult"] --> L2["Level2: manual or run deps"]
  L2 --> L3["Level3: createWorkflow + durable"]
```

This repo tracks **Awaitly 4.2**, which has four entry points instead of thirteen:

| Entry | Carries |
|-------|---------|
| `awaitly` | Results, `run`, `createWorkflow`, steps, resources, batching, policies |
| `awaitly/result` | Result primitives only — the minimal-bundle guarantee |
| `awaitly/durable` | Durable execution, persistence, sagas, human-in-the-loop, streaming, webhooks, engine |
| `awaitly/testing` | Test helpers, kept out of production bundles |

Nothing was removed: `awaitly/run` and `awaitly/workflow` folded into `awaitly`, and `awaitly/saga`, `awaitly/hitl`, `awaitly/streaming`, `awaitly/persistence`, `awaitly/webhook`, and `awaitly/engine` folded into `awaitly/durable`. The theme of the release is that reaching for `as const`, a cast, or a restated error list is treated as a library problem, so each was removed rather than documented — see [api-comparison.md §3](./src/comparison/api-comparison.md) for what inferred error unions now look like on hover.

**4.1 continues that theme**, and three of its changes show up in this repo's examples:

| Change | What it removes |
|--------|-----------------|
| `errors: ['PARSE_FAILED']` joins the workflow's error union | A `step.try` error that no dep produces used to need all four type parameters of `createWorkflow` spelled out |
| Stream failures arrive as typed values (`STREAM_READ_ERROR`), like `STEP_TIMEOUT` | Infrastructure failing no longer disguises itself as `UnexpectedError`; only your own callback throws stay exceptions |
| Optional options accept `undefined` | `cache: options?.cache` works under `exactOptionalPropertyTypes` — no conditional spread per field (see `data-pipeline.test.ts`) |

Also in 4.1: `durable.run` accepts a `streamStore`, so durable execution and streaming compose in one call, and `catchUnexpected` keeps a literal tag without `as const`.

**4.2** finishes the job on declared errors: `durable.run` takes `errors` too, so the durable path can name an error its deps don't produce — including putting `STREAM_READ_ERROR` in the static union, which is what makes the boundary `switch` in [data-pipeline.md §5](./src/comparison/data-pipeline.md) exhaustive rather than a string comparison.

See [api-comparison.md](./src/comparison/api-comparison.md) for pattern-by-pattern examples at each level.

## Four Philosophies

**Four ways to think about failure:**

```mermaid
graph LR
    subgraph "Safety Net (try/catch)"
        A1["🤹 Happy path"]
        A2["💥 Slip"]
        A3["🥅 Caught (maybe)"]
        A1 --> A2
        A2 --> A3
    end

    subgraph "Railway (neverthrow)"
        B1["🛤️ Success track"]
        B2["🚦 Switch point"]
        B3["⚠️ Error track"]
        B1 --> B2
        B2 --> B3
    end

    subgraph "Control Room (Effect)"
        C1["📋 Blueprint"]
        C2["🎛️ Control panel"]
        C3["⚡ Execute"]
        C1 --> C2
        C2 --> C3
    end

    subgraph "Result + optional steps (Awaitly)"
        D1["ok/err + AsyncResult"]
        D2["Combinators or step()"]
        D3["Workflows when needed"]
        D1 --> D2
        D2 --> D3
    end
```

### 🎭 The Optimist (try/catch)

"Everything will work fine... oh crap, something broke, quick, catch it!"

This is the approach most developers know and love. Write your code assuming everything will work perfectly. When reality intrudes (and it will), let the exception bubble up until someone, somewhere, catches it.

```typescript
async function makePayment(data: unknown) {
  try {
    // Assume everything works perfectly
    const payment = validatePayment(data);
    const result = await chargeCustomer(payment);
    await saveToDatabase(result);
    return { success: true };
  } catch (error) {
    // In core logic: convert/rethrow. Log at the system boundary to avoid double-logging.
    throw error;
  }
}
```

In real code, "convert" often means mapping unknown exceptions into a typed `InfrastructureError` at the boundary:

```typescript
app.post('/pay', async (req, res) => {
  try {
    const result = await makePayment(req.body);
    res.json(result);
  } catch (e) {
    const err = AppError.fromUnknown(e);
    res.status(err.httpStatus).json({ error: err.message });
  }
});
```

**The Mental Model: The Trapeze Artist**

Picture this: You're flying through the air doing complex acrobatics. You're focused on the performance, the timing, the catches, the crowd's applause. If something goes wrong? Well, there's a safety net down there somewhere.

The beauty of this approach is its simplicity. The horror of this approach is also its simplicity.

```mermaid
flowchart TD
    subgraph "The Performance (Happy Path)"
        P1["🤹 Step 1: Validate"]
        P2["🤹 Step 2: Check duplicates"]
        P3["🤹 Step 3: Acquire lock"]
        P4["🤹 Step 4: Call provider"]
        P5["🤹 Step 5: Persist result"]
        P6["🎉 Success!"]
        P1 --> P2 --> P3 --> P4 --> P5 --> P6
    end

    subgraph "The Safety Net (catch blocks)"
        N1["🥅 ValidationError"]
        N2["🥅 IdempotencyConflict"]
        N3["🥅 ProviderUnavailable"]
        N4["🥅 PersistError"]
    end

    P1 -."💥 throw".-> N1
    P2 -."💥 throw".-> N2
    P4 -."💥 throw".-> N3
    P5 -."💥 throw".-> N4
```

**When to use this:**

Use try/catch for simple operations, rapid prototyping, or at system boundaries (HTTP handlers, event listeners) where you need to catch unexpected errors and return an appropriate HTTP response.

**The limitations:**

**Function signatures hide failure modes**

The signature says `Promise<{paymentId: string}>` but conceals 5+ different error types. You discover missing error handlers at runtime, usually in production.

**Happy path becomes scattered**

The success flow is interrupted by defensive try/catch blocks. Following the business logic requires jumping between success cases and error handling.

**No static analysis of error paths**

TypeScript cannot verify that you've handled all error cases. Forget to catch an error? The compiler shrugs. You find out when the pager goes off.

**Composition breaks down**

Calling this from another function requires wrapping it in another try/catch. The complexity multiplies exponentially with each layer of abstraction.

Don't get me wrong: this approach works great at system boundaries. HTTP controllers, event handlers, that sort of thing. But in your core business logic? It's like doing surgery with oven mitts.

---

### 🚂 The Realist (neverthrow)

"Half of everything breaks, so let's plan for that from the start"

What if failure wasn't a surprise? What if your functions were honest about what could go wrong, and the compiler actually helped you handle it?

This is the world of Railway-Oriented Programming. Instead of pretending everything will work and then panicking when it doesn't, we build two tracks from the start: the success track and the failure track.

```typescript
import { Result, ok, err } from 'neverthrow';

async function makePayment(
  data: unknown
): Promise<Result<PaymentSuccess, PaymentError>> {
  const validationResult = validatePayment(data);
  if (validationResult.isErr()) {
    return err(validationResult.error); // Stop here, pass the error along
  }

  const chargeResult = await chargeCustomer(validationResult.value);
  if (chargeResult.isErr()) {
    return err(chargeResult.error); // Something went wrong, but we handle it gracefully
  }

  // Only continue if everything is OK
  return ok({ success: true });
}
```

**The Mental Model: Two Tracks, One Journey**

Think of it like this: every function returns a train that's either on the success track or the error track. The train carries a `Result<Success, Error>` that's either:

- `Ok(value)`: "All good, staying on the success track"
- `Err(error)`: "Something went wrong, switching to the error track"

```mermaid
flowchart LR
    subgraph "Two-Track Railway"
        S1["✅ Success Track"]
        S2["✅ Step 2"]
        S3["✅ Step 3"]
        S4["🎉 Final Success"]

        E1["❌ Error Track"]
        E2["❌ Still Error"]
        E3["❌ Still Error"]
        E4["💥 Final Error"]

        SW1{"🚦 Switch"}
        SW2{"🚦 Switch"}
        SW3{"🚦 Switch"}

        S1 --> SW1
        SW1 -->|"Ok"| S2
        SW1 -->|"Err"| E1

        S2 --> SW2
        SW2 -->|"Ok"| S3
        SW2 -->|"Err"| E2

        S3 --> SW3
        SW3 -->|"Ok"| S4
        SW3 -->|"Err"| E3

        E1 --> E2 --> E3 --> E4
    end
```

The key idea: once you're on the error track, you stay there until someone explicitly handles it. No more surprises. No more "oh wait, this could actually throw an exception."

**When to use this:**

Use neverthrow when your business logic has multiple failure modes that need different handling, when you need composable error handling, or when you want error-handling discipline in core logic.

**Why this works better:**

**Function signatures are honest**

`Promise<Result<{paymentId: string}, PaymentError>>` tells you exactly what you're getting: either a payment ID or an error. No surprises, no hidden exceptions. The type system makes error handling explicit in the signature.

**Composition is natural**

```typescript
return parse(raw)
  .andThen((input) => checkExisting(db, input))
  .andThen((input) => acquireLock(db, input))
  .andThen((input) => callProvider(provider, input))
  .andThen((response) => persistSuccess(db, input, response))
  .orElse((error) => handleSpecificErrors(error));
```

It reads like a pipeline. Each step either succeeds and passes its result to the next step, or fails and jumps straight to the error handler. The flow is explicit and visual.

**Note:** These advantages (honest signatures, natural composition, errors as data) apply equally to Awaitly. Both libraries implement railway-oriented programming with Result types. The difference is syntax: neverthrow uses method chaining (`.andThen()`), while Awaitly uses manual checks, deps-first `run({ … }, async (s) => …)`, or `step()` inside workflows. If your team prefers async/await flows, Awaitly lets you keep that syntax while still getting early-exit error propagation.

**Errors are data, not control flow**

Instead of exceptions flying around, you have error values you can inspect, transform, and reason about. Want to log all validation errors differently from database errors? Easy. Want to retry only certain error types? Trivial.

---

### 🏗️ The Architect (Effect)

"Let's describe exactly what should happen, then let the system figure it out"

What if you didn't write code to do things, but instead wrote code to describe what should be done?

What if timeouts, retries, logging, and dependency injection weren't scattered throughout your code like confetti, but were declared upfront as policies?

Welcome to Effect, where you're not a programmer: you're an architect drawing blueprints.

```typescript
import { Effect } from 'effect';

// (Assume validatePayment/chargeCustomer/saveToDatabase return Effect values, not promises.)

const makePayment = (data: unknown) =>
  Effect.gen(function* () {
    const payment = yield* validatePayment(data);
    const result = yield* chargeCustomer(payment);
    yield* saveToDatabase(result);
    return { success: true };
  }).pipe(
    Effect.timeout(5000),
    Effect.withLogSpan('payment')
  );
```

**The Mental Model: The Blueprint Factory**

Picture this: You're designing a factory, but you don't actually build anything. Instead, you create incredibly detailed blueprints that specify:

- What machines you need (dependencies)
- How long each process should take (timeouts)
- What to do when machines break (retries, circuit breakers)
- How all the pieces fit together (composition)
- What should be logged and when (observability)

The upside: you can test the blueprint without building the factory. You can swap out machine specifications without changing the blueprint. You can simulate failures and see how the system responds.

```mermaid
flowchart TD
    subgraph "Effect: Blueprint-First Design"
        subgraph "1. Describe (Effect)"
            B1["📋 Payment workflow"]
            B2["⏰ Timeout: 2000ms"]
            B3["🔄 Retry: 3x exponential"]
            B4["🏗️ Dependencies: Db, Provider"]
            B5["❌ Error handling"]
        end

        subgraph "2. Configure (Layer)"
            L1["🔌 Wire up Db service"]
            L2["🔌 Wire up Provider service"]
            L3["📊 Add logging"]
            L4["🧪 Swap for testing"]
        end

        subgraph "3. Execute (Runtime)"
            R1["⚡ Effect.runPromise()"]
            R2["🎯 Run with retries"]
            R3["⏱️ Apply timeouts"]
            R4["🔍 Manage dependencies"]
        end

        B1 --> L1
        B2 --> L2
        B3 --> L3
        B4 --> L4
        B5 --> R1

        L1 --> R2
        L2 --> R3
        L3 --> R4
        L4 --> R4
    end
```

Then you hand the blueprint to a runtime engineer who actually builds and operates the factory.

**When to use this:**

Use Effect when you need sophisticated orchestration patterns (retries, timeouts, circuit breakers), when testability is critical, when you want consistent policies across your entire application, or when your team has bandwidth to learn functional programming concepts.

**Why you might want this:**

**Policies become first-class citizens**

Want to retry with exponential backoff? That's not scattered implementation code: that's a policy you declare once and reuse everywhere:

```typescript
// (Imports omitted for brevity: Schedule, Layer, etc.)

const retryPolicy = Schedule.exponential(200).pipe(
  Schedule.jittered, // Add randomness to avoid thundering herd
  Schedule.recurs(3) // Maximum 3 retries
);

const program = callProvider.pipe(
  Effect.timeout(2000), // Timeout policy
  Effect.retry(retryPolicy) // Retry policy
);
```

**Testing becomes straightforward**

Same program, different reality:

```typescript
// Production: real database, real payment provider
const prodLayer = Layer.merge(DbService.live, ProviderService.live);

// Testing: fake everything
const testLayer = Layer.merge(DbService.test, ProviderService.mock);

// Same program runs in both environments
await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
```

**Everything composes consistently**

Same retry logic everywhere. Consistent error handling across your entire app. Want to add tracing? Add it once, get it everywhere.

---

### 🎼 Awaitly (Results first, workflows optional)

Awaitly starts as a Result library. Each function returns `ok(value)` or `err(error)`. No workflow wrapper required.

**Level 1: plain Results**

```typescript
import { ok, err, type AsyncResult } from 'awaitly';

const validatePayment = async (data: unknown): AsyncResult<Payment, ValidationError> =>
  isValid(data) ? ok(parsePayment(data)) : err(new ValidationError('Invalid'));

const chargeCustomer = async (payment: Payment): AsyncResult<ChargeResult, PaymentError> =>
  ok({ success: true });

const saveToDatabase = async (result: ChargeResult): AsyncResult<void, DatabaseError> =>
  ok(undefined);
```

**Level 2: composition with manual checks (or sync combinators)**

```typescript
import { ok, type AsyncResult, type ErrorsOf } from 'awaitly';

const deps = { validatePayment, chargeCustomer, saveToDatabase };
type PaymentErrors = ErrorsOf<typeof deps>;

const processPayment = async (
  data: unknown,
): AsyncResult<{ success: true }, PaymentErrors> => {
  const paymentResult = await deps.validatePayment(data);
  if (!paymentResult.ok) return paymentResult;

  const chargeResult = await deps.chargeCustomer(paymentResult.value);
  if (!chargeResult.ok) return chargeResult;

  const saveResult = await deps.saveToDatabase(chargeResult.value);
  if (!saveResult.ok) return saveResult;

  return ok({ success: true as const });
};
```

Sync `andThen` / `map` apply only to sync `Result` values (callback must return `Result`, not `AsyncResult`).

**Level 3: `run(deps, fn)` for early exit without manual checks**

```typescript
import { run } from 'awaitly';

const result = await run(
  { validatePayment, chargeCustomer, saveToDatabase },
  async (s) => {
    const payment = await s.validatePayment(data);
    const charge = await s.chargeCustomer(payment);
    await s.saveToDatabase(charge);
    return { success: true };
  },
);

// result.error: ValidationError | PaymentError | DatabaseError | UnexpectedError
```

Use `createWorkflow()` when you need caching, resume state, or named production workflows:

```typescript
import { createWorkflow } from 'awaitly';

// Declare dependencies → error union computed automatically
const makePayment = createWorkflow('makePayment', { validatePayment, chargeCustomer, saveToDatabase });

const result = await makePayment.run(async ({ step, deps }) => {
  const payment = await step('validatePayment', () => deps.validatePayment(data), { key: 'validate' }); // Cached
  const charge = await step('chargeCustomer', () => deps.chargeCustomer(payment), { key: 'charge' });
  await step('saveToDatabase', () => deps.saveToDatabase(charge), { key: 'save' });
  return { success: true };
});

// result.error: ValidationError | PaymentError | DatabaseError | UnexpectedError
// ↑ Computed automatically from { validatePayment, chargeCustomer, saveToDatabase }
```

**Why caching/resume matters (especially for payments):**

If the provider charge succeeds but persistence fails, a naive retry can charge twice. Step keys let you resume without repeating side effects.

```typescript
const makePayment = createWorkflow('makePayment', { validatePayment, callProvider, persistSuccess });

const result = await makePayment.run(async ({ step, deps }) => {
  const payment = await step('validatePayment', () => deps.validatePayment(data), { key: 'validate' });

  // Never repeat this once it succeeds:
  const charge = await step('callProvider', () => deps.callProvider(payment), {
    key: `charge:${payment.idempotencyKey}`,
  });

  // If this fails (DB down), you can rerun later and resume here without re-charging:
  await step('persistSuccess', () => deps.persistSuccess(payment, charge), { key: `persist:${charge.id}` });

  return { paymentId: charge.paymentId };
});
```

**When to use each level:**

| Level | API | Use when |
|-------|-----|----------|
| 1 | `ok`/`err`, `AsyncResult` | You want typed errors like neverthrow |
| 2 | Manual checks + `ErrorsOf`, or `run(deps, fn)` | You want composition without workflows |
| 3 | `createWorkflow()`, `durable` | You need caching, resume, or production orchestration |

**Why you might want Level 2 `run(deps, fn)`:**

Write normal async/await code; bound steps unwrap Results and exit early on error.

```typescript
const result = await run({ fetchUser, fetchPosts }, async (s) => {
  const user = await s.fetchUser('1');
  const posts = await s.fetchPosts(user.id);
  return { user, posts };
});
```

**Early exit is automatic**

`step()` unwraps Results. If it's an error, the execution exits immediately. No need to check `.isErr()` everywhere. The happy path stays clean and readable.

**Handle throwing operations with step.try()**

For operations that might throw (like wrapping existing APIs), use `step.try()` to convert exceptions to typed errors:

```typescript
const response = await step.try('riskyOp', () => riskyOperation(), {
  error: 'OPERATION_FAILED', // or a factory: (cause) => ({ type: 'OPERATION_FAILED', message: String(cause) })
});
```

**Automatic error inference with createWorkflow**

You declare your functions, and the error union is computed automatically. Add a new function? The error types update automatically. Remove one? TypeScript ensures you handle the new error set.

```typescript
const workflow = createWorkflow('workflow', { fetchUser, fetchPosts, sendEmail });
// Error type: 'NOT_FOUND' | 'FETCH_ERROR' | 'EMAIL_FAILED' | UnexpectedError
// ↑ Computed automatically, no manual union management
```

**Step caching and resume state**

Expensive operations can be cached by key. Workflows can be paused and resumed. Perfect for long-running processes or human-in-the-loop workflows.

**Retries and timeouts built-in**

Awaitly includes production-ready scheduling without needing a separate library:

```typescript
// Retry with exponential backoff
const user = await step.retry(
  'fetchUser',
  () => fetchUser(id),
  { attempts: 3, backoff: 'exponential', initialDelay: 100, jitter: true }
);

// Timeout with AbortSignal support
const data = await step.withTimeout(
  'fetch',
  (signal) => fetch(url, { signal }),
  { ms: 5000, signal: true }
);
```

Pre-built policies are available for common patterns:

```typescript
import { retryPolicies, timeoutPolicies } from 'awaitly';

const user = await step.retry('fetchUser', () => fetchUser(id), retryPolicies.transient);
```

**Streaming with Results**

Awaitly 4 exposes Result-aware stream processing from `awaitly/durable`:

```typescript
import { createWorkflow } from 'awaitly';
import { createMemoryStreamStore, pipe, map, filter, chunk } from 'awaitly/durable';

// The stream store is a workflow option; step.getReadable() reads from it
const streamStore = createMemoryStreamStore();

const job = createWorkflow('processLines', { saveBatch }, { streamStore });

await job.run(async ({ step, deps }) => {
  const reader = step.getReadable<string>({ namespace: 'input' });

  // Transformers are data-first over async iterables: pipe(source, ...stages)
  const batches = pipe(
    reader,
    (s) => map(s, (line) => line.toUpperCase()),
    (s) => filter(s, (line) => line.length > 0),
    (s) => chunk(s, 100)
  );

  let total = 0;
  for await (const batch of batches) {
    await step('saveBatch', () => deps.saveBatch(batch), { key: `batch:${total}` });
    total += batch.length;
  }

  return { total };
});
```

**Result composition and fetch boundaries**

Awaitly 4 keeps the public surface focused. Result combinators such as `map`,
`andThen`, and `allAsync` come from `awaitly`; HTTP calls use the platform's
`fetch` wrapped with `tryAsync`, so applications own their domain error model.

**step.sleep() with Duration Support**

Cancellation-aware delays with human-readable duration strings:

```typescript
import { run, seconds, minutes } from 'awaitly';

await run(async ({ step }) => {
  // String duration syntax (ID first, then duration)
  await step.sleep('delay', '5s');
  await step.sleep('delay', '1m 30s');

  // Duration helpers
  await step.sleep('delay', seconds(5));
  await step.sleep('delay', minutes(1));

  // With AbortSignal for cancellation
  const controller = new AbortController();
  await step.sleep('delay', '10s', { signal: controller.signal });

  // With caching
  await step.sleep('delay', '5s', { key: 'rate-limit-delay' });
});
```

---

## Which One Should I Choose?

Here's the honest truth: **it depends on what you're building**.

### Start with try/catch if:

- You're building something simple with straightforward error handling
- Your team is learning JavaScript/TypeScript fundamentals
- You need to ship quickly and iteration speed matters more than compile-time safety
- You're working at system boundaries (HTTP handlers, event listeners) where you need to catch unexpected errors and return an appropriate HTTP response

### Consider neverthrow when:

- Your business logic has multiple failure modes that need different handling
- You want the compiler to verify that you've handled all error cases
- You're tired of forgetting to catch exceptions and discovering them in production
- You need composable error handling that works well with functional patterns

### Look at Effect when:

- You need the full ecosystem (dependency injection, layers, structured concurrency, tracing)
- Testability is critical and you want pure dependency injection with swappable services
- You want consistent policies applied uniformly via layers across your entire application
- Your team has capacity to learn functional programming concepts and advanced abstractions

### Consider Awaitly when:

- You want typed Results with `ok`/`err` (Level 1, no workflows required)
- You prefer async/await over neverthrow method chaining
- You want combinators (`andThen`, `tryAsync`) without adopting Effect
- You need automatic error inference, step caching, or resume (Level 3)
- You need retries, timeouts, or circuit breakers without Effect's ecosystem
- Your team knows async/await but wants better error handling than try/catch

## The Decision Tree

```mermaid
flowchart TD
    Start([Need to handle errors?]) --> Simple{Simple use case?}

    Simple -->|Yes| TryCatch[try/catch]
    Simple -->|No| NeedResults{Need typed Results?}

    NeedResults -->|Yes| PreferChains{Prefer method chaining?}
    NeedResults -->|No| Effect[Effect]

    PreferChains -->|Yes| Neverthrow[neverthrow]
    PreferChains -->|No| AwaitlyL1[Awaitly Level 1 or 2]

    AwaitlyL1 --> NeedOrchestration{Need caching, resume, or inference?}
    NeedOrchestration -->|Yes| AwaitlyL3[Awaitly Level 3]
    NeedOrchestration -->|No| AwaitlyL1

    AwaitlyL1 --> NeedPolicies{Need policies beyond Results?}
    NeedPolicies -->|Yes| TeamReady{Team ready for FP?}
    NeedPolicies -->|No| AwaitlyL1

    TeamReady -->|Yes| NeedFibers{Need fibers and structured concurrency?}
    TeamReady -->|No| AwaitlyL3

    NeedFibers -->|Yes| Effect
    NeedFibers -->|No| AwaitlyL3

    TryCatch --> TryCatchGood["Simple cases, hidden errors"]

    Neverthrow --> NeverthrowGood["Explicit errors, manual unions"]

    AwaitlyL1 --> AwaitlyL1Good["ok/err and combinators, no workflows"]

    AwaitlyL3 --> AwaitlyL3Good["run, createWorkflow, durable"]

    Effect --> EffectGood["Full ecosystem, steep learning curve"]
```

**In practice, most systems mix styles:** try/catch at boundaries, explicit Results in core workflows, and policy-driven orchestration only where it pays off. Don't force a single hammer.

## A Simple Example: Division

Let's see how each approach handles a simple division function:

```typescript
// throwing approach (caught at the boundary)
function divideThrow(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}
```

```typescript
// neverthrow approach
import { Result as NtResult, ok as ntOk, err as ntErr } from 'neverthrow';

function divideNeverthrow(a: number, b: number): NtResult<number, Error> {
  return b === 0 ? ntErr(new Error('Division by zero')) : ntOk(a / b);
}
```

```typescript
// Effect approach
import { Effect } from 'effect';

const divideEffect = (a: number, b: number) =>
  b === 0 ? Effect.fail(new Error('Division by zero')) : Effect.succeed(a / b);
```

```typescript
// Awaitly approach (Level 1: plain Results, no workflow)
import { ok, err, type Result } from 'awaitly';

function divideAwaitly(a: number, b: number): Result<number, Error> {
  return b === 0 ? err(new Error('Division by zero')) : ok(a / b);
}

const result = divideAwaitly(10, 2);
// result.ok ? result.value : result.error

// For multi-step flows, add run() or andThen at Level 2/3. Not required here.
```

Notice how the function signatures tell different stories:

- try/catch: `number` (lies about potential failure)
- neverthrow: `Result<number, Error>` (honest about what can happen)
- Effect: `Effect<number, Error, never>` (describes a computation that might fail)
- Awaitly: `Result<number, Error>` (honest types, same as neverthrow at Level 1)

## Want to Learn More?

- 📖 **[ADVANCED.md](./ADVANCED.md)** - Deep dive into implementation details, migration strategies, and performance considerations
- 🔌 **[Integration Guides](./src/integrations/)** - Using Awaitly with Zod, Prisma, React Query, and more
- 💻 **[src/](./src/)** - Complete working examples of all four approaches
- 🧪 **Run the examples** - `npm install && npm test` to see them in action

### Integration Guides

Awaitly works alongside your existing libraries:

| Library | Guide | Description |
| :--- | :--- | :--- |
| **Zod** | [zod.md](./src/integrations/zod.md) | Validation errors → typed Results |
| **Prisma** | [prisma.md](./src/integrations/prisma.md) | Database errors → exhaustive handling |
| **React Query** | [react-query.md](./src/integrations/react-query.md) | Server state with Result types |
| **neverthrow** | [neverthrow-migration.md](./src/integrations/neverthrow-migration.md) | Gradual migration path |

## The Uncomfortable Truth

Here's what I've learned after years of building systems that break in creative ways:

**Errors aren't bugs: they're features.** The difference between a junior developer and a senior developer isn't that the senior writes bug-free code. It's that the senior developer has learned to design around the inevitable failure.

You already have a rubric now: **Visible, Composable, Honest**.  
Pick the trade-off you're willing to live with: at 3 AM, you won't care what was "elegant." You'll care what was **understandable**.

**There's no "correct" choice here.** Each approach is a tool. Use try/catch when you need simplicity. Use neverthrow when you need composability. Use Awaitly Level 1 when you want neverthrow-style Results with async/await. Add Awaitly workflows when caching or resume matters. Use Effect when you need the full architectural toolkit.

But whatever you choose, choose deliberately. Don't just throw try/catch around everything and hope for the best. And don't pick Effect just because it sounds impressive on your resume.

Your future self (the one being woken up at 3 AM because payments are down) will thank you for thinking this through.
