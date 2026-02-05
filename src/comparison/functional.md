# Real-World Scenario: Functional Composition

**Scenario:** Building reusable data transformation pipelines with type-safe error handling.
**Key Constraints:** Composability, reusability, readable data flow.

See the code: `functional.test.ts`

## The Approaches

### 1. Neverthrow (Method Chaining)

Neverthrow uses method chaining for composition:

```typescript
import { ok, err, Result, ResultAsync } from 'neverthrow';

// Define individual functions
const validateEmail = (email: string): Result<string, 'INVALID_EMAIL'> =>
  email.includes('@') ? ok(email) : err('INVALID_EMAIL');

const validatePassword = (password: string): Result<string, 'WEAK_PASSWORD'> =>
  password.length >= 8 ? ok(password) : err('WEAK_PASSWORD');

const createUser = (
  email: string,
  password: string
): ResultAsync<User, 'DB_ERROR'> =>
  ResultAsync.fromPromise(db.insert({ email, password }), () => 'DB_ERROR');

// Compose with method chaining
const signUp = (email: string, password: string) =>
  validateEmail(email)
    .andThen((validEmail) =>
      validatePassword(password).map((validPassword) => ({
        email: validEmail,
        password: validPassword,
      }))
    )
    .asyncAndThen(({ email, password }) => createUser(email, password));
```

**Pros:**
- Fluent API
- Good TypeScript inference
- Familiar to OOP developers

**Cons:**
- Nested callbacks for multi-step chains
- Can't easily extract reusable pipelines
- Variable scoping gets awkward

### 2. Effect (pipe/flow)

Effect provides functional composition utilities:

```typescript
import { Effect, pipe, flow } from 'effect';

// Define individual functions
const validateEmail = (email: string): Effect.Effect<string, 'INVALID_EMAIL'> =>
  email.includes('@')
    ? Effect.succeed(email)
    : Effect.fail('INVALID_EMAIL' as const);

const validatePassword = (
  password: string
): Effect.Effect<string, 'WEAK_PASSWORD'> =>
  password.length >= 8
    ? Effect.succeed(password)
    : Effect.fail('WEAK_PASSWORD' as const);

const createUser = (
  email: string,
  password: string
): Effect.Effect<User, 'DB_ERROR'> =>
  Effect.tryPromise({
    try: () => db.insert({ email, password }),
    catch: () => 'DB_ERROR' as const,
  });

// Compose with pipe
const signUp = (email: string, password: string) =>
  pipe(
    Effect.all([validateEmail(email), validatePassword(password)]),
    Effect.flatMap(([validEmail, validPassword]) =>
      createUser(validEmail, validPassword)
    )
  );

// Or create reusable pipelines with flow
const validateUser = flow(
  (data: { email: string; password: string }) =>
    Effect.all([validateEmail(data.email), validatePassword(data.password)]),
  Effect.map(([email, password]) => ({ email, password }))
);
```

**Pros:**
- Powerful composition
- Reusable pipelines with `flow`
- Part of comprehensive ecosystem

**Cons:**
- Requires learning Effect paradigm
- Heavy bundle for just composition

### 3. Awaitly Functional (v1.11.0)

`awaitly/functional` provides Effect-style utilities for Result types:

```typescript
import { pipe, flow, compose, R } from 'awaitly/functional';
import { ok, err, type Result, type AsyncResult } from 'awaitly';

// Define individual functions (same as before)
const validateEmail = (email: string): Result<string, 'INVALID_EMAIL'> =>
  email.includes('@') ? ok(email) : err('INVALID_EMAIL');

const validatePassword = (password: string): Result<string, 'WEAK_PASSWORD'> =>
  password.length >= 8 ? ok(password) : err('WEAK_PASSWORD');

const createUser = (
  email: string,
  password: string
): AsyncResult<User, 'DB_ERROR'> =>
  db
    .insert({ email, password })
    .then((user) => ok(user))
    .catch(() => err('DB_ERROR'));

// Compose with pipe (apply value through functions)
const signUp = (email: string, password: string) =>
  pipe(
    { email, password },
    (data) => validateEmail(data.email),
    R.andThen((validEmail) =>
      pipe(
        validatePassword(password),
        R.map((validPassword) => ({ email: validEmail, password: validPassword }))
      )
    ),
    R.andThen(({ email, password }) => createUser(email, password))
  );

// Create reusable pipelines with flow
const validateUserData = flow(
  (data: { email: string; password: string }) => validateEmail(data.email),
  R.andThen((email) =>
    R.map(validatePassword(data.password), (password) => ({ email, password }))
  )
);

// Use in workflow
const workflow = createWorkflow({ validateUserData, createUser });

const result = await workflow(async (step, deps) => {
  const validated = await step('validateUserData', () => deps.validateUserData({ email, password }));
  return await step('createUser', () => deps.createUser(validated.email, validated.password));
});
```

## R Namespace Reference

The `R` namespace provides curried, pipeable functions for Results:

```typescript
import { R } from 'awaitly/functional';

// Transform success values
R.map((x) => x * 2)           // Result<A, E> => Result<B, E>

// Transform error values
R.mapError((e) => new Error(e)) // Result<A, E1> => Result<A, E2>

// Chain operations (flatMap)
R.andThen((x) => fetchData(x))  // Result<A, E1> => Result<B, E1 | E2>

// Recover from errors
R.orElse((e) => ok(defaultValue)) // Result<A, E> => Result<A, F>

// Extract value with default
R.unwrapOr(defaultValue)        // Result<A, E> => A

// Side effects without changing value
R.tap((x) => console.log(x))    // Result<A, E> => Result<A, E>
R.tapError((e) => logError(e))  // Result<A, E> => Result<A, E>

// Conditional execution
R.filter(predicate, error)      // Result<A, E> => Result<A, E | E2>
```

## Collection Utilities

```typescript
import { all, allAsync, allSettled, any, race, traverse } from 'awaitly/functional';

// all: Combine sync Results (first-error semantics)
const result = all([
  validateEmail(email),
  validatePassword(password),
  validateUsername(username),
]);
// Result<[string, string, string], 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'INVALID_USERNAME'>

// allAsync: Combine async Results
const result = await allAsync([
  fetchUser(userId),
  fetchPosts(userId),
  fetchComments(userId),
]);

// allSettled: Collect ALL errors (for form validation)
const result = allSettled([
  validateEmail(email),
  validatePassword(password),
]);
// Error contains array of all failures

// any: First success wins (for fallbacks)
const result = await any([
  tryCache(key),
  tryDatabase(key),
  tryApi(key),
]);

// race: First to complete (success or error)
const result = await race([
  fetchFromEurope(),
  fetchFromAsia(),
]);

// traverse: Map then combine
const result = await traverse(userIds, (id) => fetchUser(id));
// Equivalent to: allAsync(userIds.map(id => fetchUser(id)))
```

## Comparison Table

| Feature | Neverthrow | Effect | Awaitly Functional |
|---------|------------|--------|-------------------|
| **API Style** | Method chaining | pipe/flow/gen | pipe/flow/R |
| **Reusable Pipelines** | Limited | `flow` | `flow` |
| **Curried Helpers** | No | Yes | `R` namespace |
| **Collection Utils** | `combine` | `Effect.all` | `all/allAsync/traverse` |
| **First-Success** | No | `Effect.firstSuccessOf` | `any` |
| **All-Errors** | `combineWithAllErrors` | `Effect.all({ mode: 'either' })` | `allSettled` |
| **Learning Curve** | Low | High | Low-Medium |
| **Bundle Size** | Small | Large | Small |
| **Ecosystem** | Minimal | Massive | Focused |

## When to Use Each

### Choose Neverthrow Method Chaining When:
- Simple 1-3 step chains
- Team prefers OOP style
- Don't need reusable pipelines

### Choose Effect pipe/flow When:
- Already using Effect ecosystem
- Need structured concurrency
- Building complex domain models

### Choose Awaitly Functional When:
- Want Effect-style composition without full Effect
- Transitioning from Neverthrow
- Need collection utilities (any, race, traverse)
- Using Awaitly workflows

## Conclusion

For **Functional Composition**:
- **Awaitly Functional** bridges the gap between Neverthrow's simplicity and Effect's power. Same `pipe`/`flow` patterns, but for Result types you already know.
- **Effect** remains the gold standard if you need the full ecosystem (Layers, Fibers, Streams).
- **Neverthrow** method chaining works for simple cases but doesn't scale to complex pipelines.

### Honest Assessment

**Awaitly Functional Strengths:**
- Familiar `pipe`/`flow` patterns from Effect
- Works with existing Result types
- Smaller learning curve than full Effect
- Useful collection utilities (any, race, traverse)

**Awaitly Functional Limitations:**
- No Fiber semantics or structured concurrency
- No Effect's Layer/Context for DI
- Less comprehensive than Effect's combinators
- Designed as stepping stone, not replacement
