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

### 3. Awaitly 4 Result Combinators

Awaitly 4 exports data-first Result combinators from `awaitly` / `awaitly/result`. They operate on **sync** `Result` values — the callback to `andThen` must return a `Result`, not an `AsyncResult`. For async sequential work, use manual checks + `ErrorsOf`, or `run(deps, fn)`.

```typescript
import { andThen, map, mapError, ok, run, type ErrorsOf } from 'awaitly';

// Sync Result pipeline
const validated = validateUser(input); // Result, not AsyncResult
const enriched = andThen(validated, enrichUser);
const projected = map(enriched, (user) => ({ id: user.id, name: user.name }));
const result = mapError(projected, toApiError);

// Async sequential composition
const deps = { fetchUser, fetchPosts };
type LoadErrors = ErrorsOf<typeof deps>;

const asyncResult = await run(deps, async (s) => {
  const user = await s.fetchUser('1');
  const posts = await s.fetchPosts(user.id);
  return { user, posts };
});
```

There is no `awaitly/functional` package and no `pipe`/`flow`/`R` namespace in Awaitly 4. Collection helpers such as `all`, `allAsync`, `allSettled`, and `any` are exported from `awaitly`. The companion `functional.test.ts` uses a local educational mock of `pipe`/`R` for sync Result demos only.

Two Awaitly 4 changes affect the collection helpers:

- `any` / `anyAsync` take a **non-empty** tuple. An empty array is now a compile error and `EmptyInputError` is gone from the return type — one fewer case to handle, caught before it ships. A value typed as a plain `Result[]` needs a non-empty tuple type or a length check, since TypeScript cannot tell whether it has elements.
- `allAsync` / `anyAsync` no longer report `PromiseRejectedError`. A rejected promise is a thrown exception, which `UnexpectedError` and `catchUnexpected` already cover, so it no longer widens every caller's union. `anyAsync` also stops letting a thrown racer mask a modelled failure: a modelled error always wins, and the exception propagates only if every racer threw. `allSettledAsync` is unchanged — per-item `PromiseRejectedError` is the point of it.

## Comparison Table

| Feature | Neverthrow | Effect | Awaitly 4 |
|---------|------------|--------|-----------|
| **API Style** | Method chaining | pipe/flow/gen | Data-first combinators + `run(deps)` |
| **Reusable Pipelines** | Limited | `flow` | Sync `andThen`/`map`; async via `run` |
| **Curried Helpers** | No | Yes | No (data-first) |
| **Collection Utils** | `combine` | `Effect.all` | `all` / `allAsync` / `allSettled` |
| **First-Success** | No | `Effect.firstSuccessOf` | `any` |
| **All-Errors** | `combineWithAllErrors` | `Effect.all({ mode: 'either' })` | `allSettled` |
| **Learning Curve** | Low | High | Low |
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

### Choose Awaitly 4 When:
- Want Result types with async/await composition (`run(deps, fn)`)
- Transitioning from Neverthrow
- Need collection utilities (`any`, `allSettled`) without Effect
- Using Awaitly workflows for caching/resume

## Conclusion

For **Functional Composition**:
- **Awaitly 4** bridges Neverthrow's Result model and Effect-style composition via deps-first `run`, without requiring generators or a `pipe`/`R` DSL.
- **Effect** remains the gold standard if you need the full ecosystem (Layers, Fibers, Streams).
- **Neverthrow** method chaining works for simple cases but doesn't scale to complex pipelines.

### Honest Assessment

**Awaitly 4 Strengths:**
- Familiar `ok`/`err` Result types
- `run(deps, fn)` keeps multi-step flows linear
- Smaller learning curve than full Effect
- Useful collection utilities (`any`, `allSettled`)

**Awaitly 4 Limitations:**
- No Fiber semantics or structured concurrency
- No Effect's Layer/Context for DI
- Sync combinators only — async chaining is manual or via `run`
- Not a full Effect replacement
