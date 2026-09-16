# Awaitly integration notes

These notes are Awaitly-only. They are not a four-way comparison. neverthrow and Effect have their own docs for Zod, Prisma, and React Query.

Map library errors to `Result`, then compose with `run(deps, fn)` if the flow has several steps. Workflows are optional.

```typescript
// Before: Zod throws on invalid input
const user = UserSchema.parse(input);

// After Level 1: Zod returns a Result
const validated = zodToResult(UserSchema, input);
if (!validated.ok) {
  return validated; // typed ValidationError
}
const user = validated.value;

// After (optional): same Result, composed with run(deps, fn)
const result = await run({ zodToResult }, async (s) => {
  return s.zodToResult(UserSchema, input);
});
```

Functions return `Result`. Compose with `run` when several steps share an error union.

## Integration Guides

| Library | Use Case | Guide |
| :--- | :--- | :--- |
| **Zod** | Validation errors → typed Results | [zod.md](./zod.md) |
| **Prisma** | Database errors → exhaustive handling | [prisma.md](./prisma.md) |
| **React Query** | Server state with Result types | [react-query.md](./react-query.md) |
| **neverthrow** | Gradual migration path | [neverthrow-migration.md](./neverthrow-migration.md) |

## Quick Pattern: The Integration Wrapper

Every integration follows the same pattern: wrap the library's error handling to return a `Result`:

```typescript
import { ok, err, type Result } from 'awaitly';

// Generic pattern: Library error → typed Result
const libraryToResult = <T, E>(
  operation: () => T,
  mapError: (e: unknown) => E
): Result<T, E> => {
  try {
    return ok(operation());
  } catch (e) {
    return err(mapError(e));
  }
};

// Async version
const libraryToResultAsync = async <T, E>(
  operation: () => Promise<T>,
  mapError: (e: unknown) => E
): Promise<Result<T, E>> => {
  try {
    return ok(await operation());
  } catch (e) {
    return err(mapError(e));
  }
};
```

Use Results on their own, or wrap them in `run()` for multi-step flows:

```typescript
import { ok, err, type Result } from 'awaitly';

const validated = zodToResult(Schema, input);
if (!validated.ok) return validated;

const saved = await prismaToResult(() => db.user.create({ data: validated.value }));
return saved;
```

Optional composition with `run(deps, fn)`:

```typescript
import { run } from 'awaitly';

const validate = () => zodToResult(Schema, input);
const createUser = () => prismaToResult(() => db.user.create({ data: input }));

const result = await run({ validate, createUser }, async (s) => {
  const validated = await s.validate();
  return s.createUser();
});
```

The signature names the errors:

```typescript
async function createUser(data: unknown): Promise<User>
async function createUser(data: unknown): AsyncResult<User, ValidationError | DbError>
```

## Common Utilities

Copy these helpers into your project:

```typescript
// src/lib/result-utils.ts
import { ok, err, type Result, type AsyncResult } from 'awaitly';

/**
 * Wrap a sync operation that might throw
 */
export const tryCatch = <T, E>(
  fn: () => T,
  mapError: (e: unknown) => E
): Result<T, E> => {
  try {
    return ok(fn());
  } catch (e) {
    return err(mapError(e));
  }
};

/**
 * Wrap an async operation that might throw
 */
export const tryCatchAsync = async <T, E>(
  fn: () => Promise<T>,
  mapError: (e: unknown) => E
): AsyncResult<T, E> => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(mapError(e));
  }
};

/**
 * Convert a nullable value to a Result
 */
export const fromNullable = <T, E>(
  value: T | null | undefined,
  error: E
): Result<T, E> => {
  return value != null ? ok(value) : err(error);
};
```

