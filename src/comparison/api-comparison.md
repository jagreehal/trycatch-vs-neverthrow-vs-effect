# API Feature Comparison

This document provides a direct, pattern-by-pattern comparison of **Neverthrow**, **Effect**, and **Awaitly** based on the test suite in `api-comparison.test.ts`.

It highlights how each library handles common tasks like result construction, chaining, error inference, and parallelism.

## 1. Basic Result Construction

How do you create a success or failure value?

### Neverthrow
Explicit `ok` and `err` functions.
```typescript
import { ok, err } from 'neverthrow';
const success = ok({ id: '1' });
const failure = err('NOT_FOUND');
```

### Effect
`Effect.succeed` and `Effect.fail`. These create "blueprints" for values, not the values themselves (until run).
```typescript
import { Effect } from 'effect';
const success = Effect.succeed({ id: '1' });
const failure = Effect.fail('NOT_FOUND');
```

### awaitly
Same shape as Neverthrow: `{ ok: true, value: ... }` or `{ ok: false, error: ... }`. This is the minimum Awaitly surface. You can stop here.

```typescript
import { ok, err } from 'awaitly';
const success = ok({ id: '1' });
const failure = err('NOT_FOUND');
```

---

## 2. Sequential Operations

How do you chain dependent operations (e.g., fetch user -> fetch posts)?

### Neverthrow (Method Chaining)
Uses fluent chaining with `.andThen()`. Great for short chains, but can lead to "callback hell" nesting or complex variable passing for longer chains.
```typescript
fetchUser('1')
  .andThen(user => fetchPosts(user.id)
    .map(posts => ({ user, posts }))
  );
```

### Effect (Generators)
Uses `Effect.gen` and `yield*` to flatten syntax. Looks like async/await.
```typescript
Effect.gen(function* () {
  const user = yield* fetchUser('1');
  const posts = yield* fetchPosts(user.id);
  return { user, posts };
});
```

### Awaitly (manual checks, no workflow)
Await each `AsyncResult`, early-return on error. Type the union with `ErrorsOf`. No `run()` or `createWorkflow()` required.

```typescript
import { ok, type AsyncResult, type ErrorsOf } from 'awaitly';

const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> => /* ... */;
const fetchPosts = (userId: string): AsyncResult<Post[], 'FETCH_ERROR'> => /* ... */;

const deps = { fetchUser, fetchPosts };
type LoadErrors = ErrorsOf<typeof deps>;

const loadUserData = async (
  id: string,
): AsyncResult<{ user: User; posts: Post[] }, LoadErrors> => {
  const userResult = await deps.fetchUser(id);
  if (!userResult.ok) return userResult;

  const postsResult = await deps.fetchPosts(userResult.value.id);
  if (!postsResult.ok) return postsResult;

  return ok({ user: userResult.value, posts: postsResult.value });
};
```

Sync `andThen` / `map` only work on sync `Result` values (callback must return `Result`, not `AsyncResult`).

### Awaitly (`run(deps, fn)`, still not a workflow)
Deps-first `run` unwraps successes and exits early on error. The deps object gives the error union.

```typescript
import { run } from 'awaitly';

const result = await run({ fetchUser, fetchPosts }, async (s) => {
  const user = await s.fetchUser('1');
  const posts = await s.fetchPosts(user.id);
  return { user, posts };
});
```

### Awaitly (`createWorkflow`, the optional production tier)
Add `createWorkflow()` when you need caching, resume, or named production workflows.

```typescript
import { createWorkflow } from 'awaitly';

const loadUserData = createWorkflow('loadUserData', { fetchUser, fetchPosts });

const result = await loadUserData.run(async ({ step, deps }) => {
  const user = await step('getUser', () => deps.fetchUser('1'));
  const posts = await step('getPosts', () => deps.fetchPosts(user.id));
  return { user, posts };
});
```

**DX Verdict:**
- **Neverthrow:** Clean for 1-2 steps. Harder for 3+.
- **Effect:** Flat syntax with generators. Requires learning Effect.
- **Awaitly:** Start with manual checks + `ErrorsOf`. Add `run(deps, fn)` when if-boilerplate hurts; `createWorkflow()` when you need caching/resume.

---

## 3. Error Type Inference

How easy is it to know what errors your code might throw?

### Neverthrow
Manual union types are often required. You declare the error types in function signatures or reach for helpers, and you guard synchronous validations before entering async chains.
```typescript
type SignUpError = 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'DB_ERROR';

const signUp = (email: string, password: string): ResultAsync<User, SignUpError> => {
  const emailResult = validateEmail(email);
  if (emailResult.isErr()) return errAsync(emailResult.error);

  const passwordResult = validatePassword(password);
  if (passwordResult.isErr()) return errAsync(passwordResult.error);

  return createUser(emailResult.value, passwordResult.value);
};
```

### Effect
Typed at every step. The second type parameter of `Effect<Success, Error, Requirements>` carries the errors.
```typescript
// Error type: 'NOT_FOUND' | 'FETCH_ERROR'
```

### awaitly
**Automatic inference** with deps-first `run({ ... }, fn)` or `createWorkflow`. Derive named unions with `ErrorsOf<typeof deps>` for the manual path.
```typescript
import { createWorkflow, run, type ErrorsOf } from 'awaitly';

const deps = { fetchUser, fetchPosts };
type MyErrors = ErrorsOf<typeof deps>;
// 'NOT_FOUND' | 'FETCH_ERROR'

// Deps-first run: error union inferred (plus UnexpectedError)
const result = await run(deps, async (s) => {
  const user = await s.fetchUser('1');
  return user;
});

const myWorkflow = createWorkflow('myWorkflow', deps);
// TypeScript knows: 'NOT_FOUND' | 'FETCH_ERROR' | UnexpectedError
```

**What Awaitly 4 changed:** the inferred union is now *displayed* as its concrete literals. Through v3, hovering `result.error` on an inferred workflow showed an opaque alias, `ErrorsOf<{ …the whole deps object… }>`, because a named alias over a generic never expands in TypeScript's display. The type was right and you could not read it, so a typo like `result.error === 'NOT_FUOND'` looked plausible in the editor. Now the same hover reads `'NOT_FOUND' | 'FETCH_ERROR' | UnexpectedError`, and the typo is an obvious compile error. This puts awaitly level with Effect's explicit error channel without asking you to write the union down.

**DX Verdict:** Awaitly's inference removes the hand-written union, and in v4 you can see what it inferred.

---

## 4. Wrapping Throwing Code

How do you handle 3rd party code that might throw exceptions?

### Neverthrow
`ResultAsync.fromPromise()`.
```typescript
ResultAsync.fromPromise(
  api.call(),
  (e) => 'API_ERROR' // Error mapper
)
```

### Effect
`Effect.tryPromise()`.
```typescript
Effect.tryPromise({
  try: () => api.call(),
  catch: (e) => 'API_ERROR'
})
```

### awaitly
`step.try()` inside a workflow (run or createWorkflow). Converts thrown exceptions to a typed error and exits the workflow.
```typescript
// Inside run() or createWorkflow callback:
return await step.try('apiCall', () => api.call(), { error: 'API_ERROR' });
```

---

## 5. Parallel Operations

How do you run tasks in parallel?

### Neverthrow
`ResultAsync.combine()`. List of results -> Result of list.
```typescript
ResultAsync.combine([task1, task2])
```

### Effect
`Effect.all()`.
```typescript
Effect.all([task1, task2], { concurrency: 'unbounded' })
```

### awaitly
`allAsync()` for ad-hoc parallel results, or `step.all()` inside a workflow for named parallel operations (first argument is the step name).
```typescript
import { allAsync } from 'awaitly';

// Standalone: combine multiple AsyncResults
const result = await allAsync([fetchUser('1'), fetchPosts('1')]);

// Inside createWorkflow or run(): named parallel steps
const { user, posts } = await step.all('Fetch user and posts', {
  user: () => deps.fetchUser('1'),
  posts: () => deps.fetchPosts('1'),
});
```

---

## 6. Error Recovery

How do you handle an error and continue?

### Neverthrow
`.orElse()`.
```typescript
fetchUser('999').orElse(() => ok(defaultUser))
```

### Effect
`Effect.catch()`.
```typescript
fetchUser('999').pipe(
  Effect.catch(() => Effect.succeed(defaultUser))
)
```

### awaitly
Recover at the **boundary** after composition returns, or use the `match()` helper on a Result.
```typescript
import { run, match } from 'awaitly';

const result = await run({ fetchUser }, async (s) => s.fetchUser('999'));

// Recover at boundary
const user = result.ok
  ? result.value
  : result.error === 'NOT_FOUND'
    ? defaultUser
    : null;

// Or use match() on a single Result (e.g. from a dep)
const recovered = match(userResult, {
  ok: (value) => value,
  err: (error) => (error === 'NOT_FOUND' ? defaultUser : defaultUser),
});
```

---

## 7. Circuit Breaker

How do you prevent cascading failures?

### Neverthrow
Manual implementation required.

### Effect
Manual implementation or community libraries.

### awaitly
Built-in `createCircuitBreaker` with presets.
```typescript
import { createCircuitBreaker, circuitBreakerPresets } from 'awaitly';

const breaker = createCircuitBreaker('api', circuitBreakerPresets.standard);

const result = await breaker.executeResult(() =>
  step('callApi', () => deps.callExternalApi())
);
```

---

## 8. Rate Limiting

How do you control throughput?

### Neverthrow
Manual implementation required.

### Effect
Manual implementation required.

### awaitly
Built-in `createRateLimiter` and `createConcurrencyLimiter`.
```typescript
import { createRateLimiter, createConcurrencyLimiter } from 'awaitly';

const limiter = createRateLimiter('api', { maxPerSecond: 10 });
const poolLimiter = createConcurrencyLimiter('db', { maxConcurrent: 5 });

const data = await limiter.execute(() => step('callApi', () => deps.callApi()));
```

---

## 9. Saga / Compensation

How do you handle rollback when multi-step operations fail?

### Neverthrow
Manual compensation tracking.

### Effect
Manual via effect handlers.

### awaitly
Built-in `createSagaWorkflow` with automatic LIFO compensation.
```typescript
import { createSagaWorkflow } from 'awaitly/durable';

const checkout = createSagaWorkflow('checkout', {
  reserve,
  release,
  charge,
  refund,
  ship,
});

await checkout.run(async ({ step, deps }) => {
  await step('reserve', () => deps.reserve(items), {
    compensate: (r) => deps.release(r.id),
  });
  await step('charge', () => deps.charge(amount), {
    compensate: (p) => deps.refund(p.id),
  });
  await step('ship', () => deps.ship(orderId)); // If this fails, compensations run
});
```

---

## 10. Policies

How do you apply consistent retry/timeout behavior?

### Neverthrow
Manual wrappers.

### Effect
Via `Schedule` composition.

### awaitly
Built-in policy system with presets.
```typescript
import { servicePolicies, withPolicy } from 'awaitly';

const user = await step(
  'fetchUser',
  () => deps.fetchUser(id),
  withPolicy(servicePolicies.httpApi, { description: 'fetch-user' })
);
// servicePolicies.httpApi = 5s timeout + 3 retries with exponential backoff
```

---

---

## 11. Streaming Comparison

How do you process data streams with Result types?

### Neverthrow
Manual implementation with Node.js streams or async iterators.

### Effect
Effect Stream provides powerful stream processing:
```typescript
import { Stream, Effect } from 'effect';

const processed = Stream.fromIterable(data).pipe(
  Stream.map((item) => item.toUpperCase()),
  Stream.filter((item) => item.length > 0),
  Stream.runCollect
);
```

### Awaitly
`awaitly/durable` provides Result-aware stream transformers. They are data-first functions over async iterables, with the source first, composed with `pipe`:
```typescript
import { pipe, map, filter, collect } from 'awaitly/durable';

const processed = pipe(
  reader, // step.getReadable<string>({ namespace: 'input' })
  (s) => map(s, (item) => item.toUpperCase()),
  (s) => filter(s, (item) => item.length > 0)
);

// collect() returns a plain promise, so a caller who wants an array gets one
const results = await collect(processed);
```

A stream failure is not lost by that choice. Since Awaitly 4.1 a failing read arrives as a typed value at the workflow boundary, the same way `STEP_TIMEOUT` does, instead of being wrapped in `UnexpectedError`:

```typescript
if (!result.ok && (result.error.type ?? result.error) === 'STREAM_READ_ERROR') {
  return { status: 503 }; // the store is down, retry
}
```

Only a throw from your *own* transform callback stays an `UnexpectedError`. Effect models this in the error channel of the stream itself; awaitly keeps it in the same `result.error` union you already match on.

---

## 12. Functional Composition Comparison

How do you compose functions in a pipeline?

### Neverthrow
Uses method chaining:
```typescript
validateUser(data)
  .map((user) => enrichUser(user))
  .andThen((user) => saveUser(user))
  .mapErr((e) => new ApiError(e));
```

### Effect
Uses `pipe` and `Effect.map/flatMap`:
```typescript
import { pipe, Effect } from 'effect';

pipe(
  validateUser(data),
  Effect.map((user) => enrichUser(user)),
  Effect.flatMap((user) => saveUser(user)),
  Effect.mapError((e) => new ApiError(e))
);
```

### Awaitly
Awaitly 4 exports data-first Result combinators from the root (sync `Result` only):
```typescript
import { andThen, map, mapError } from 'awaitly';

const validated = validateUser(data); // Result, not AsyncResult
const enriched = map(validated, enrichUser);
const saved = andThen(enriched, saveUser); // saveUser returns Result
const result = mapError(saved, (error) => new ApiError(error));
```

For async sequential work, use manual checks + `ErrorsOf`, or `run(deps, fn)`.

---

## 13. Fetch Helpers Comparison

How do you make type-safe HTTP requests?

### Neverthrow
Manual wrapping with `ResultAsync.fromPromise()`:
```typescript
const fetchUser = (id: string) =>
  ResultAsync.fromPromise(
    fetch(`/api/users/${id}`).then((r) => r.json()),
    () => 'FETCH_ERROR'
  );
```

### Effect
Uses `HttpClient` service:
```typescript
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

const fetchUser = (id: string) =>
  HttpClient.get(`/api/users/${id}`).pipe(
    Effect.flatMap(HttpClientResponse.json),
    Effect.mapError(() => 'FETCH_ERROR')
  );
```

### Awaitly
Awaitly 4 wraps the platform boundary with `tryAsync` and application-defined errors:
```typescript
import { tryAsync } from 'awaitly';

const result = await tryAsync(
  async () => {
    const response = await fetch(`/api/users/${id}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<User>;
  },
  () => 'FETCH_ERROR' as const,
);
```

---

## Summary

| Feature | Neverthrow | Effect | Awaitly |
| :--- | :--- | :--- | :--- |
| **Paradigm** | Functional (Chaining) | Functional (Blueprint) | Results first; workflows optional |
| **Syntax** | `.andThen().map()` | `yield* Effect...` | Manual / `run(deps, fn)` / `await step(...)` |
| **Learning Curve** | Low | High | Low |
| **Inference** | Good | Excellent | Excellent (`ErrorsOf`, `run(deps)`, `createWorkflow`) |
| **Circuit Breaker** | Manual | Manual | Built-in (optional) |
| **Rate Limiting** | Manual | Manual | Built-in (optional) |
| **Saga Pattern** | Manual | Manual | Built-in (optional) |
| **Policies** | Manual | Via Schedule | Built-in (optional) |
| **Durable Execution** | Manual | Manual | Built-in (optional) |
| **Streaming** | Manual | Stream module | Built-in (optional) |
| **Functional Utils** | Method chaining | pipe/flow | Sync `andThen`/`map`; async via `run` |
| **Fetch Helpers** | Manual | HttpClient | `tryAsync` + native `fetch` |
| **Lint Plugin** | ✓ (ESLint) | ✓ (ESLint, or `@effect/tsgo` through `tsc`) | ✓ (ESLint or oxlint) |
| **Ecosystem** | Minimal | Massive | Focused |

**Choose based on:**
- **Neverthrow:** Functional chains and a lightweight library for simple error handling.
- **Effect:** Structured concurrency, DI with layers, powerful streams, and you can invest in learning FP.
- **Awaitly:** Start with Results (`ok`/`err`) and manual checks + `ErrorsOf`. Add `run(deps, fn)` for composition; `createWorkflow()` when you need caching, resume, or policies.
