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

const loadUserData = createWorkflow({ fetchUser, fetchPosts });

const result = await loadUserData(async (step, deps) => {
  const user = await step(() => deps.fetchUser('1'));
  const posts = await step(() => deps.fetchPosts(user.id));
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

const myWorkflow = createWorkflow({ fetchUser, fetchPosts });
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
await step.try(
  () => api.call(),
  { error: 'API_ERROR' }
)
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
  () => allAsync(items.map(item => deps.processItem(item))),
  {
    onError: (error): ProcessError => {
      if (isPromiseRejectedError(error)) return 'PROCESS_FAILED';
      return error;
    },
    name: 'Process items'
  }
);

// For named parallel operations, use step.parallel
const { users, posts } = await step.parallel(
  {
    users: () => deps.fetchUsers(),
    posts: () => deps.fetchPosts(),
  },
  { name: 'Fetch data' }
);
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
const result = await workflow(async (step, deps) => {
  const userResult = await deps.fetchUser('999');
  
  if (!userResult.ok && userResult.error === 'NOT_FOUND') {
    return defaultUser;
  }
  
  // Unwrap and continue
  return await step(userResult);
});

// Or use match() helper
import { match } from 'awaitly';
const user = match(userResult, {
  ok: (value) => value,
  err: (error) => error === 'NOT_FOUND' ? defaultUser : defaultUser,
});
```

---

## Summary

| Feature | Neverthrow | Effect | Awaitly |
| :--- | :--- | :--- | :--- |
| **Paradigm** | Functional (Chaining) | Functional (Blueprint) | Imperative (Async/Await) |
| **Syntax** | `.andThen().map()` | `yield* Effect...` | `await step(...)` |
| **Learning Curve** | Low | High | Low |
| **Inference** | Good | Excellent | Excellent (Auto-unions) |
| **Ecosystem** | Minimal | Massive | Focused |

**Choose based on:**
- **Neverthrow:** If you love functional chains and want a lightweight library.
- **Effect:** If you need a complete runtime system (retries, logging, context) and are willing to learn.
- **Awaitly:** If you want the safety of Results but the syntax of async/await, plus automatic error inference.
