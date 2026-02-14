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
Similar to Neverthrow, but returns simple objects `{ ok: true, value: ... }` or `{ ok: false, error: ... }`.
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

### Awaitly (Async/Await)
Uses standard `async/await` with a `step()` wrapper. The `step` function automatically handles early exits on error.
```typescript
import { createWorkflow } from 'awaitly/workflow';

const loadUserData = createWorkflow('loadUserData', { fetchUser, fetchPosts });

const result = await loadUserData(async ({ step, deps }) => {
  const user = await step('getUser', () => deps.fetchUser('1'));
  const posts = await step('getPosts', () => deps.fetchPosts(user.id));
  return { user, posts };
});
```

**DX Verdict:**
- **Neverthrow:** Clean for 1-2 steps. Harder for 3+.
- **Effect:** Excellent, flat syntax. Requires understanding generators.
- **Awaitly:** Most familiar for JS/TS devs (just async/await).

---

## 3. Error Type Inference

How easy is it to know what errors your code might throw?

### Neverthrow
Manual union types often required. You must explicitly declare the error types in function signatures or use helpers, and you typically need to guard synchronous validations before entering async chains.
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
Strongly typed. Errors are tracked in the second type parameter `Effect<Success, Error, Requirements>`.
```typescript
// Error type: 'NOT_FOUND' | 'FETCH_ERROR'
```

### awaitly
**Automatic inference**. When using `createWorkflow`, the library automatically computes the union of all possible errors from the dependencies you use.
```typescript
import { createWorkflow } from 'awaitly/workflow';

const myWorkflow = createWorkflow('myWorkflow', { fetchUser, fetchPosts });
// TypeScript automatically knows the error is: 'NOT_FOUND' | 'FETCH_ERROR'
```

**DX Verdict:** Awaitly's automatic inference reduces boilerplate significantly.

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
`step.try()`.
```typescript
await step.try('apiCall', () => api.call(), { error: 'API_ERROR' });
```

---

## 5. Parallel Operations

How do you run tasks concurrently?

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
`allAsync()` helper with `step.fromResult()` for error handling, or `step.parallel()` for named operations.
```typescript
import { allAsync, isPromiseRejectedError } from 'awaitly';

// For dynamic arrays, use step.fromResult with error handling
const results = await step.fromResult(
  'processItems',
  () => allAsync(items.map(item => deps.processItem(item))),
  {
    onError: (error): ProcessError => {
      if (isPromiseRejectedError(error)) return 'PROCESS_FAILED';
      return error;
    },
  }
);

// For named parallel operations, use step.parallel
const { users, posts } = await step.parallel('Fetch data', {
  users: () => deps.fetchUsers(),
  posts: () => deps.fetchPosts(),
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
`Effect.catchAll()`.
```typescript
fetchUser('999').pipe(
  Effect.catchAll(() => Effect.succeed(defaultUser))
)
```

### awaitly
Get the raw result, check it, then unwrap with `step()` if needed. Or use `match` helper for pattern matching.
```typescript
// Inline recovery inside workflow
const result = await workflow(async ({ step, deps }) => {
  const userResult = await deps.fetchUser('999');
  
  if (!userResult.ok && userResult.error === 'NOT_FOUND') {
    return defaultUser;
  }
  
  // Unwrap and continue
  return await step('getUser', () => userResult);
});

// Or use match() helper
import { match } from 'awaitly';
const user = match(userResult, {
  ok: (value) => value,
  err: (error) => error === 'NOT_FOUND' ? defaultUser : defaultUser,
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
import { createCircuitBreaker, circuitBreakerPresets } from 'awaitly/circuit-breaker';

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
import { createRateLimiter, createConcurrencyLimiter } from 'awaitly/ratelimit';

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
import { createSagaWorkflow } from 'awaitly/saga';

const saga = createSagaWorkflow({ reserve, charge, ship });

await saga(async (ctx, deps) => {
  await ctx.step(() => deps.reserve(items), {
    compensate: (r) => release(r.id)
  });
  await ctx.step(() => deps.charge(amount), {
    compensate: (p) => refund(p.id)
  });
  await ctx.step(() => deps.ship(orderId)); // If this fails, compensations run
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
import { servicePolicies, withPolicy } from 'awaitly/policies';

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
`awaitly/streaming` provides Result-aware stream transformers:
```typescript
import { map, filter, collect } from 'awaitly/streaming';

const processed = readable
  .pipeThrough(map((item) => ok(item.toUpperCase())))
  .pipeThrough(filter((item) => item.length > 0));

const results = await step('collect', () => collect(processed));
```

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
`awaitly/functional` provides similar utilities:
```typescript
import { pipe, R } from 'awaitly/functional';

pipe(
  data,
  validateUser,
  R.map((user) => enrichUser(user)),
  R.andThen((user) => saveUser(user)),
  R.mapError((e) => new ApiError(e))
);
```

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
import { HttpClient, HttpClientResponse } from '@effect/platform';

const fetchUser = (id: string) =>
  HttpClient.get(`/api/users/${id}`).pipe(
    Effect.flatMap(HttpClientResponse.json),
    Effect.mapError(() => 'FETCH_ERROR')
  );
```

### Awaitly
`awaitly/fetch` provides built-in helpers with error types:
```typescript
import { fetchJson } from 'awaitly/fetch';

const result = await fetchJson<User>(`/api/users/${id}`);
// Error type: NOT_FOUND | BAD_REQUEST | UNAUTHORIZED | FORBIDDEN | SERVER_ERROR | NETWORK_ERROR
```

---

## Summary

| Feature | Neverthrow | Effect | Awaitly |
| :--- | :--- | :--- | :--- |
| **Paradigm** | Functional (Chaining) | Functional (Blueprint) | Imperative (Async/Await) |
| **Syntax** | `.andThen().map()` | `yield* Effect...` | `await step(...)` |
| **Learning Curve** | Low | High | Low |
| **Inference** | Good | Excellent | Excellent (Auto-unions) |
| **Circuit Breaker** | Manual | Manual | Built-in |
| **Rate Limiting** | Manual | Manual | Built-in |
| **Saga Pattern** | Manual | Manual | Built-in |
| **Policies** | Manual | Via Schedule | Built-in |
| **Durable Execution** | Manual | Manual | Built-in |
| **Streaming** | Manual | Stream module | Built-in |
| **Functional Utils** | Method chaining | pipe/flow | pipe/flow/R |
| **Fetch Helpers** | Manual | HttpClient | fetchJson/fetchText |
| **ESLint Plugin** | ✓ | ✓ | ✓ |
| **Ecosystem** | Minimal | Massive | Focused |

**Choose based on:**
- **Neverthrow:** If you love functional chains and want a lightweight library for simple error handling.
- **Effect:** If you need structured concurrency with fibers, sophisticated DI with layers, powerful streams, and are willing to learn.
- **Awaitly:** If you want production-grade reliability (circuit breakers, rate limiting, sagas, durability, streaming, functional utils) with familiar async/await syntax.
