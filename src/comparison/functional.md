# Functional composition

Reusable pipelines with typed errors. The constraint is how you glue small functions, not which logo is on the import.

See `functional.test.ts`.

## The Approaches

### 1. neverthrow (method chaining)

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

**Fits this constraint:** fluent `.andThen` / `.map`. Inference is good on short chains.

**Costs:** multi-step chains nest. A reusable pipeline is a wrapper function.

### 2. Effect (`pipe` / `flow`)

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

**Fits this constraint:** `flow` builds a reusable pipeline. `pipe` is the same shape as the rest of Effect.

**Costs:** you learn the Effect model. Bundle is large if composition is all you import.

### 3. Awaitly Result combinators

Data-first functions on **sync** `Result`. The callback to `andThen` returns a `Result`, not an `AsyncResult`. Async sequential work uses manual checks + `ErrorsOf`, or `run(deps, fn)`.

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

There is no `awaitly/functional` package and no `pipe`/`flow`/`R` namespace in Awaitly. Collection helpers such as `all`, `allAsync`, `allSettled`, and `any` are exported from `awaitly`. The companion `functional.test.ts` uses a local educational mock of `pipe`/`R` for sync Result demos only.

Two details of the collection helpers:

- `any` / `anyAsync` take a **non-empty** tuple. An empty array is a compile error, so that case disappears before it ships. A value typed as a plain `Result[]` needs a non-empty tuple type or a length check, since TypeScript cannot tell whether it has elements.
- `allAsync` / `anyAsync` do not report `PromiseRejectedError`. A rejected promise is a thrown exception, which `UnexpectedError` and `catchUnexpected` cover, so it does not widen every caller's union. In `anyAsync` a modelled error always wins over a thrown racer, and the exception propagates only if every racer threw. `allSettledAsync` reports per-item `PromiseRejectedError`, since that is the point of it.

## Comparison Table

| Feature | neverthrow | Effect | Awaitly |
|---------|------------|--------|-----------|
| **API** | Method chaining | pipe / flow / gen | Data-first combinators + `run(deps)` |
| **Reusable pipeline** | Wrapper function | `flow` | Sync `andThen`/`map`; async via `run` |
| **Curried helpers** | No | Yes | No (data-first) |
| **Collections** | `combine` | `Effect.all` | `all` / `allAsync` / `allSettled` |
| **First success** | No | `Effect.firstSuccessOf` | `any` |
| **All errors** | `combineWithAllErrors` | `Effect.all({ mode: 'either' })` | `allSettled` |

## Against this constraint

- **Reusable `flow` pipelines and curried helpers:** Effect.
- **Method chaining on `Result`:** neverthrow. Fine for 1–3 steps; longer chains nest or use `safeTry`.
- **Data-first `andThen`/`map` on sync Results, async via `run`:** Awaitly. No Fiber, no Layer, no `pipe`/`R` DSL.
