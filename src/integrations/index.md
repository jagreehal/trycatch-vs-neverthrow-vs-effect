# Using Awaitly With Your Existing Stack

Awaitly isn't a platform you adopt; it's **type-safe glue** for your existing tools.

Unlike Effect's "adopt the ecosystem" approach, Awaitly enhances the libraries you already use. Add it to one function, one module, one feature at a time.

## The Philosophy

**Win-win integration.** Awaitly makes your existing libraries better:
- **Zod** validation errors become typed Results
- **Prisma** database errors get exhaustive handling
- **React Query** works with Result types out of the box
- **neverthrow** users can migrate gradually

**Incremental adoption.** Start with one function:
```typescript
// Before: Zod throws on invalid input
const user = UserSchema.parse(input); // 💥 throws ZodError

// After: Zod returns a Result you can compose
const user = await step('validateUser', () => zodToResult(UserSchema, input)); // ✅ typed error handling
```

**No lock-in.** Your functions return standard `Result` types that work anywhere.

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

Then use it in workflows:

```typescript
import { Awaitly } from 'awaitly';
import { run } from 'awaitly/run';

const result = await run(async ({ step }) => {
  const validated = await step('validate', () => zodToResult(Schema, input));
  const saved = await step('createUser', () => prismaToResult(() => db.user.create({ data: validated })));
  return saved;
}, { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR });
```

## Why This Approach Works

**1. Honest function signatures**

Your functions tell the truth about what can fail:
```typescript
// Before: What errors can this throw? 🤷
async function createUser(data: unknown): Promise<User>

// After: Exhaustive error types in the signature
async function createUser(data: unknown): AsyncResult<User, ValidationError | DbError>
```

**2. Composable across libraries**

Mix and match integrations in a single workflow:
```typescript
import { Awaitly } from 'awaitly';
import { run } from 'awaitly/run';

const result = await run(async ({ step }) => {
  // Zod validation
  const input = await step('validateInput', () => zodToResult(CreateUserSchema, rawData));

  // Prisma database operation
  const user = await step('createUser', () => prismaToResult(() =>
    db.user.create({ data: input })
  ));

  // HTTP call with typed errors
  const welcome = await step('fetchWelcome', () => fetchJson(`/api/welcome/${user.id}`));

  return { user, welcome };
}, { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR });
```

**3. Gradual adoption**

Add Awaitly to new code while keeping existing code unchanged:
```typescript
import { Awaitly } from 'awaitly';
import { run } from 'awaitly/run';

// Existing code: still works
const oldFeature = await legacyFunction();

// New code: uses Result types
const newFeature = await run(async ({ step }) => {
  return await step('modern', () => modernFunction());
}, { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR });
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

## Next Steps

1. **Start with Zod**: Most projects have validation. [See the Zod guide →](./zod.md)
2. **Add Prisma patterns**: If you use Prisma, typed database errors are a game-changer. [See the Prisma guide →](./prisma.md)
3. **Connect to React Query**: Server state with Result types. [See the React Query guide →](./react-query.md)
4. **Migrating from neverthrow?**: Gradual path with interop utilities. [See the migration guide →](./neverthrow-migration.md)
