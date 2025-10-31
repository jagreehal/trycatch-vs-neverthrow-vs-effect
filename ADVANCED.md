# Advanced Error Handling: The Complete Guide

**Deep dive into implementation details, migration strategies, and battle-tested patterns**

This document assumes you've read the [README.md](./README.md) and want to understand these error handling approaches in depth.

## Table of Contents

- [Complete Implementation Examples](#complete-implementation-examples)
- [The Mental Models Explained](#the-mental-models-explained)
- [Migration Strategies](#migration-strategies)
- [Testing Strategies](#testing-strategies)
- [Performance Considerations](#performance-considerations)
- [Error Recovery Patterns](#error-recovery-patterns)
- [Production Battle Stories](#production-battle-stories)

## Complete Implementation Examples

Let's build a realistic payment processing system using all three approaches. This isn't toy code: it's the kind of system that handles real money and can't afford to lose a penny.

### Shared Types and Infrastructure

```typescript
import { z } from 'zod';

export const CreatePayment = z.object({
  clientId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR', 'USD']),
  reference: z.string().min(1),
  idemKey: z.string().min(16),
});
export type CreatePayment = z.infer<typeof CreatePayment>;

export type ProviderResponse = {
  id: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
};

export interface Tx {
  insertPayment: (row: any) => Promise<void>;
  insertAudit: (row: any) => Promise<void>;
}

export interface Db {
  findPaymentByKey: (idemKey: string) => Promise<{ id: string } | undefined>;
  acquireLock: (idemKey: string) => Promise<boolean>;
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface Provider {
  createPayment: (input: {
    amountMinor: number;
    currency: string;
    reference: string;
  }) => Promise<ProviderResponse>;
}

// Custom error types
export class ValidationError extends Error {}
export class IdempotencyConflict extends Error {}
export class ProviderUnavailable extends Error {}
export class ProviderSoftFail extends Error {} // 5xx/429/timeouts
export class ProviderHardFail extends Error {} // 4xx
export class PersistError extends Error {}
export class TimeoutError extends Error {}
```

### Approach 1: The Optimist (try/catch)

```typescript
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new TimeoutError(`Timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function mapHttpError(status: number, body?: unknown): Error {
  if (status === 429 || status >= 500)
    return new ProviderSoftFail(`Provider ${status}`);
  if (status >= 400)
    return new ProviderHardFail(`Provider ${status}: ${JSON.stringify(body)}`);
  return new Error('Unknown provider error');
}

async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseMs: number
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof ProviderSoftFail || e instanceof TimeoutError))
        throw e;
      const backoff =
        Math.min(baseMs * 2 ** i, 3000) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw last;
}

export async function createPaymentVanilla(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
) {
  // 1) validate
  const parsed = CreatePayment.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.message);
  const input = parsed.data;

  // 2) idem
  const existing = await db.findPaymentByKey(input.idemKey);
  if (existing) return { paymentId: existing.id };

  // 3) lock
  const locked = await db.acquireLock(input.idemKey);
  if (!locked) throw new IdempotencyConflict('Concurrent request');

  // 4) provider (with timeout + mapped errors + retry)
  const call = async () => {
    try {
      return await withTimeout(
        provider.createPayment({
          amountMinor: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
        }),
        2000
      );
    } catch (e: any) {
      if (typeof e?.status === 'number') throw mapHttpError(e.status, e.body);
      throw e;
    }
  };

  let response: ProviderResponse;
  try {
    response = await retry(call, 3, 200);
  } catch (e) {
    if (e instanceof ProviderSoftFail || e instanceof TimeoutError) {
      // persist a failure record but don't mask the original reason
      await db
        .transaction(async (tx) => {
          await tx.insertPayment({
            clientId: input.clientId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            providerPaymentId: 'unknown',
            status: 'FAILED',
            idemKey: input.idemKey,
          });
          await tx.insertAudit({
            actor: actorEmail,
            action: 'PAYMENT_CREATE_FAILED',
            metadata: { reason: String(e) },
          });
        })
        .catch(() => {});
      throw new ProviderUnavailable(String(e));
    }
    throw e; // hard fail: surface it
  }

  // 5) persist success
  try {
    await db.transaction(async (tx) => {
      await tx.insertPayment({
        clientId: input.clientId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerPaymentId: response.id,
        status: response.status,
        idemKey: input.idemKey,
      });
      await tx.insertAudit({
        actor: actorEmail,
        action: 'PAYMENT_CREATED',
        metadata: { providerId: response.id },
      });
    });
  } catch (e) {
    throw new PersistError(String(e));
  }

  return { paymentId: response.id };
}
```

**What makes this challenging:**

**1. Function signature lies**

It says `Promise<{paymentId: string}>` but doesn't tell you about the 5 ways it can fail.

**2. Happy path is scattered**

Try following the success story through the code. Good luck finding it between all the try/catch blocks.

**3. Composition is painful**

Calling this from another function requires more try/catch layers. The complexity multiplies.

**4. The compiler can't help**

TypeScript shrugs and wishes you luck. You'll discover missing error handling at 3 AM when payments are down.

### Approach 2: The Realist (neverthrow)

```typescript
import { Result, ResultAsync, ok, err, okAsync, errAsync } from 'neverthrow';

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

function parse(raw: unknown) {
  return Result.fromThrowable(
    CreatePayment.parse,
    (e) => new ValidationError((e as any)?.message ?? 'Invalid')
  )(raw);
}

function acquireLock(db: Db, idemKey: string) {
  return ResultAsync.fromPromise(db.acquireLock(idemKey), toError).andThen(
    (locked) =>
      locked
        ? okAsync(true)
        : errAsync(new IdempotencyConflict('Concurrent request'))
  );
}

function retryResult<T, E extends Error>(
  thunk: () => ResultAsync<T, E>,
  shouldRetry: (e: E) => boolean,
  attempts: number
): ResultAsync<T, E> {
  return thunk().orElse((e) => {
    if (shouldRetry(e) && attempts > 1) {
      const backoff =
        Math.min(200 * 2 ** (3 - attempts), 3000) +
        Math.floor(Math.random() * 100);
      return ResultAsync.fromSafePromise(
        new Promise<void>((r) => setTimeout(r, backoff))
      ).andThen(() => retryResult(thunk, shouldRetry, attempts - 1));
    }
    return errAsync(e);
  });
}

const callProvider = (
  provider: Provider,
  input: CreatePayment
): ResultAsync<{ input: CreatePayment; resp: ProviderResponse }, Error> => {
  const makeCall = (): ResultAsync<ProviderResponse, Error> =>
    ResultAsync.fromPromise(
      withTimeout(
        provider.createPayment({
          amountMinor: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
        }),
        2000
      ),
      (e: Error) => {
        const status = (e as any)?.status;
        return typeof status === 'number'
          ? mapHttpError(status, (e as any)?.body)
          : e;
      }
    );

  return retryResult(
    makeCall,
    (e) => e instanceof ProviderSoftFail || e instanceof TimeoutError,
    3
  ).map((resp) => ({ input, resp }));
};

function persistSuccess(
  db: Db,
  actorEmail: string,
  input: CreatePayment,
  resp: ProviderResponse
) {
  return ResultAsync.fromPromise(
    db.transaction(async (tx) => {
      await tx.insertPayment({
        clientId: input.clientId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerPaymentId: resp.id,
        status: resp.status,
        idemKey: input.idemKey,
      });
      await tx.insertAudit({
        actor: actorEmail,
        action: 'PAYMENT_CREATED',
        metadata: { providerId: resp.id },
      });
      return resp.id;
    }),
    (e) => new PersistError(String(e))
  ).map((paymentId) => ({ paymentId }));
}

function persistFailure(
  db: Db,
  actorEmail: string,
  input: CreatePayment,
  error: Error
) {
  return ResultAsync.fromPromise(
    db.transaction(async (tx) => {
      await tx.insertPayment({
        clientId: input.clientId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerPaymentId: 'unknown',
        status: 'FAILED',
        idemKey: input.idemKey,
      });
      await tx.insertAudit({
        actor: actorEmail,
        action: 'PAYMENT_CREATE_FAILED',
        metadata: { reason: String(error) },
      });
    }),
    () => new ProviderUnavailable(String(error))
  ).andThen(() =>
    errAsync<never, Error>(new ProviderUnavailable(String(error)))
  );
}

export function createPaymentNeverthrow(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
): ResultAsync<{ paymentId: string }, Error> {
  const parseInput = (): Result<CreatePayment, ValidationError> =>
    Result.fromThrowable(CreatePayment.parse, (e) =>
      e instanceof z.ZodError
        ? new ValidationError(e.message)
        : new ValidationError(String(e))
    )(raw);

  const checkExisting = (
    input: CreatePayment
  ): ResultAsync<CreatePayment | { paymentId: string }, Error> =>
    ResultAsync.fromPromise(db.findPaymentByKey(input.idemKey), toError).map(
      (existing) => (existing ? { paymentId: existing.id } : input)
    );

  // Main pipeline: pure functional composition
  return parseInput()
    .asyncAndThen((input) => checkExisting(input))
    .andThen((result) => {
      // If we found an existing payment, return it immediately
      if ('paymentId' in result) {
        return okAsync(result);
      }

      // Otherwise, process the new payment
      const input = result;
      return acquireLock(db, input.idemKey)
        .andThen(() => callProvider(provider, input))
        .orElse((error) => {
          // Handle soft failures by persisting failure record
          if (
            error instanceof ProviderSoftFail ||
            error instanceof TimeoutError
          ) {
            return persistFailure(db, actorEmail, input, error);
          }
          // Hard failures bubble up immediately
          return errAsync(error);
        })
        .andThen(({ input, resp }) =>
          persistSuccess(db, actorEmail, input, resp)
        );
    });
}
```

**What makes this better:**

**1. Honest signatures**

`ResultAsync<{paymentId: string}, Error>` tells you exactly what to expect. No surprises, no hidden exceptions.

**2. Composable**

Chain operations with `andThen`, handle errors with `orElse`. The flow is a pipeline, not a maze of try/catch blocks.

**3. Errors are data**

You can inspect, log, transform, and recover from errors without special syntax. Want to log validation errors differently from database errors? Easy.

**4. Gradual adoption**

Wrap legacy code with `Result.fromThrowable()` and migrate piece by piece. No need to rewrite your entire codebase at once.

### Approach 3: The Architect (Effect)

```typescript
import { Effect, Layer, Context, Schedule, Duration } from 'effect';
import * as STM from 'effect/STM';

// Service tags for dependency injection
export const DbService = Context.GenericTag<Db>('DbService');
export const ProviderService = Context.GenericTag<Provider>('ProviderService');

const retrySchedule = Schedule.exponential(Duration.millis(200)).pipe(
  Schedule.jittered,
  Schedule.upTo(Duration.seconds(3)),
  Schedule.recurs(2)
);

// Pure functions that return Effects (composable building blocks)
const parseInput = (raw: unknown) =>
  Effect.try({
    try: () => CreatePayment.parse(raw),
    catch: (e) => new ValidationError((e as z.ZodError).message),
  });

const checkExistingPayment = (input: CreatePayment) =>
  Effect.gen(function* () {
    const db = yield* DbService;
    return yield* Effect.promise(() => db.findPaymentByKey(input.idemKey));
  });

const acquireLock = (input: CreatePayment) =>
  Effect.gen(function* () {
    const db = yield* DbService;
    const locked = yield* Effect.promise(() => db.acquireLock(input.idemKey));
    if (!locked) {
      return yield* Effect.fail(new IdempotencyConflict('Concurrent request'));
    }
    return input;
  });

const callProvider = (input: CreatePayment) =>
  Effect.gen(function* () {
    const provider = yield* ProviderService;

    const call = Effect.tryPromise({
      try: () =>
        provider.createPayment({
          amountMinor: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
        }),
      catch: (e: any) => {
        if (typeof e?.status === 'number')
          return mapHttpError(e.status, e.body);
        return e as Error;
      },
    });

    return yield* call.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(2000),
        onTimeout: () => new TimeoutError('Timed out after 2000ms'),
      }),
      Effect.retry(
        retrySchedule.pipe(
          Schedule.whileInput(
            (err: unknown) =>
              err instanceof TimeoutError || err instanceof ProviderSoftFail
          )
        )
      )
    );
  });

const persistSuccess = (
  input: CreatePayment,
  response: ProviderResponse,
  actorEmail: string
) =>
  Effect.gen(function* () {
    const db = yield* DbService;

    return yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.insertPayment({
            clientId: input.clientId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            providerPaymentId: response.id,
            status: response.status,
            idemKey: input.idemKey,
          });
          await tx.insertAudit({
            actor: actorEmail,
            action: 'PAYMENT_CREATED',
            metadata: { providerId: response.id },
          });
          return response.id;
        }),
      catch: (e) => new PersistError(String(e)),
    });
  });

const persistFailure = (
  input: CreatePayment,
  error: Error,
  actorEmail: string
) =>
  Effect.gen(function* () {
    const db = yield* DbService;

    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.insertPayment({
            clientId: input.clientId,
            amountMinor: input.amountMinor,
            currency: input.currency,
            providerPaymentId: 'unknown',
            status: 'FAILED',
            idemKey: input.idemKey,
          });
          await tx.insertAudit({
            actor: actorEmail,
            action: 'PAYMENT_CREATE_FAILED',
            metadata: { reason: String(error) },
          });
        }),
      catch: () => new ProviderUnavailable(String(error)),
    });

    return yield* Effect.fail(new ProviderUnavailable(String(error)));
  });

// Main Effect program: pure composition
export const createPaymentEffect = (raw: unknown, actorEmail: string) =>
  Effect.gen(function* () {
    // Parse input
    const input = yield* parseInput(raw);

    // Check for existing payment (idempotency)
    const existing = yield* checkExistingPayment(input);
    if (existing) {
      return { paymentId: existing.id };
    }

    // Acquire lock
    const lockedInput = yield* acquireLock(input);

    // Call provider with error recovery
    const response = yield* callProvider(lockedInput).pipe(
      Effect.catchAll((error) => {
        if (
          error instanceof TimeoutError ||
          error instanceof ProviderSoftFail
        ) {
          return persistFailure(lockedInput, error, actorEmail);
        }
        return Effect.fail(error);
      })
    );

    // Persist success
    const paymentId = yield* persistSuccess(lockedInput, response, actorEmail);
    return { paymentId };
  });

// Wiring: dependency injection
export const makeAppLayer = (db: Db, provider: Provider) =>
  Layer.merge(
    Layer.effect(DbService, Effect.succeed(db)),
    Layer.effect(ProviderService, Effect.succeed(provider))
  );

// Usage at the boundary
export const runPayment = async (
  db: Db,
  provider: Provider,
  payload: unknown,
  actor: string
) => {
  return await Effect.runPromise(
    Effect.provide(
      createPaymentEffect(payload, actor),
      makeAppLayer(db, provider)
    )
  );
};
```

**Why this is powerful:**

**1. Policies are first-class citizens**

Timeouts, retries, and logging aren't scattered through your code. They're declared upfront as policies you can see, test, and modify independently.

**2. Perfect testability**

Dependency injection through layers means you can swap real services for test implementations without mocking frameworks or complex setup.

**3. Readable despite complexity**

Effect.gen makes the code look synchronous even though it's handling complex orchestration. The control flow is clear.

**4. Composable everywhere**

Same retry logic across your entire app. Consistent error handling. Want to add tracing? Add it once, get it everywhere.

## The Mental Models Explained

### try/catch: The Exception Model

Think of exceptions as fire alarms. When something goes wrong:

1. **ALARM!** An exception is thrown
2. **EVACUATION!** Normal execution stops immediately
3. **SEARCH FOR SAFETY!** The runtime looks up the call stack for a catch block
4. **HANDLE OR PANIC!** Either someone catches it, or the whole program crashes

This works great when failures are truly exceptional. But when failures are common (network timeouts, validation errors, etc.), you're constantly setting off fire alarms for routine events.

**The problem with fire alarms for routine events:**

Every time you throw an exception, you're forcing the runtime to:
- Unwind the call stack
- Search for a handler
- Lose context about where you were
- Make recovery harder than it needs to be

### neverthrow: The Railway Model

Imagine every function as a railway junction with two tracks:

- **Success Track**: When everything works, the train stays on this track
- **Error Track**: When something fails, the train switches to this track

Once you're on the error track, you stay there until someone explicitly handles the error and switches you back to success. This makes error flow explicit and composable.

```typescript
// Each operation is a junction
validateInput(data) // Might switch to error track
  .andThen(checkDuplicates) // Only runs if on success track
  .andThen(callProvider) // Only runs if still on success track
  .orElse(handleError); // Handles error track
```

**Why this works better for business logic:**

The railway model makes failure a first-class concept. You can see the success path and error path clearly. You can handle specific errors at specific points. And you can compose operations without losing error information.

### Effect: The Blueprint Model

Effect treats your program like architectural blueprints:

1. **Description**: You describe what should happen, not how
2. **Policies**: You declare policies (timeouts, retries, etc.) separately
3. **Dependencies**: You specify what services you need
4. **Execution**: The runtime figures out how to make it happen

This separation lets you test, modify, and reason about each concern independently.

**Why blueprints matter:**

When you separate description from execution, you gain:
- The ability to test without side effects
- The ability to modify policies without changing business logic
- The ability to visualize and reason about your program structure
- The ability to swap implementations (test vs production) easily

## Migration Strategies

### The Three-Phase Evolution

**Phase 1: Foundation (try/catch everywhere)**

Start here. Build basic functionality, ship features, identify pain points where errors are hard to handle. Keep it simple until simplicity becomes painful.

**When to move to Phase 2:**
- You're writing the same error handling patterns repeatedly
- You're forgetting to catch errors and finding out at runtime
- Your error handling code is as complex as your business logic
- You need to compose operations but try/catch makes it painful

**Phase 2: Core Domain (introduce neverthrow)**

Refactor your most complex business logic to use Result types. Keep try/catch at system boundaries (HTTP handlers, event listeners, etc.). Gradually expand the Result-based code.

**When to move to Phase 3:**
- You need consistent policies (timeouts, retries) across your app
- You're implementing the same infrastructure patterns repeatedly
- Testing requires complex mocking and setup
- Your team is comfortable with functional programming concepts

**Phase 3: Policies (consider Effect)**

Only when you have complex orchestration needs. When consistent policies become important across your app. When your team is ready for the investment.

### Practical Migration Tactics

#### 1. The Wrapper Strategy

Start by wrapping existing functions without changing their internals:

```typescript
// Your existing function
async function legacyCreateUser(data: unknown): Promise<User> {
  // ... existing try/catch implementation
}

// Wrapper for neverthrow consumers
export function createUserSafe(data: unknown): ResultAsync<User, Error> {
  return ResultAsync.fromPromise(legacyCreateUser(data), (e) =>
    e instanceof Error ? e : new Error(String(e))
  );
}

// Now you can compose it
const result = createUserSafe(userData)
  .andThen((user) => validateUser(user))
  .andThen((user) => sendWelcomeEmail(user));
```

**Why this works:**

You get the benefits of Result types in new code without rewriting everything. You can migrate incrementally, testing each piece as you go.

#### 2. The Boundary Strategy

Keep try/catch at your system boundaries but use Result types internally:

```typescript
// Edge: HTTP handler (try/catch)
export async function POST_createPayment(req: Request, res: Response) {
  try {
    // Internal: Use neverthrow
    const result = await createPaymentNeverthrow(
      db,
      provider,
      req.body,
      req.user.email
    );

    if (result.isOk()) {
      res.json(result.value);
    } else {
      handlePaymentError(result.error, res);
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

**Why boundaries matter:**

System boundaries (HTTP, events, database connections) need to handle unexpected errors. try/catch is fine here. But inside your application, Result types give you better control.

#### 3. The Interoperability Patterns

```typescript
// neverthrow → try/catch
async function callNeverthrowFromTryCatch() {
  const result = await createPaymentNeverthrow(db, provider, data, actor);

  if (result.isErr()) {
    throw result.error; // Convert back to exception
  }

  return result.value;
}

// try/catch → neverthrow
function wrapLegacyFunction(data: unknown): ResultAsync<User, Error> {
  return ResultAsync.fromPromise(legacyCreateUser(data), (e) =>
    e instanceof Error ? e : new Error(String(e))
  );
}
```

**When to convert between paradigms:**

Convert to exceptions at system boundaries where the caller expects exceptions. Convert to Results when you enter your business logic where you want explicit error handling.

## Testing Strategies

### Testing try/catch: The Exception Juggling Act

```typescript
describe('try/catch payment processing', () => {
  it('should handle validation errors', async () => {
    const db = makeDb();
    const provider = makeProvider();

    // Must wrap in expect().rejects to catch the exception
    await expect(
      createPaymentVanilla(
        db,
        provider,
        { clientId: '' }, // Invalid input
        'actor@example.com'
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('should create payment successfully', async () => {
    const db = makeDb();
    const provider = makeProvider();

    // Different test structure for success case
    const result = await createPaymentVanilla(
      db,
      provider,
      validInput,
      'actor@example.com'
    );

    expect(result.paymentId).toBe('prov_ref1');
  });
});
```

**Problems with this approach:**

**1. Different test patterns for success vs failure**

Success cases return values. Failure cases throw exceptions. Your test setup changes based on what you're testing.

**2. Hard to test partial failures or recovery logic**

When you need to test "what happens after step 3 fails but step 4 succeeds", you're setting up complex mocking scenarios.

**3. Exception inspection is cumbersome**

You can't easily check error details or multiple error conditions without nested try/catch blocks or special matchers.

### Testing neverthrow: Uniform Structure

```typescript
describe('neverthrow payment processing', () => {
  it('should handle validation errors', async () => {
    const db = makeDb();
    const provider = makeProvider();

    const result = await createPaymentNeverthrow(
      db,
      provider,
      { clientId: '' }, // Invalid input
      'actor@example.com'
    );

    // Same pattern for all tests: check result type, then inspect
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('clientId');
    }
  });

  it('should create payment successfully', async () => {
    const db = makeDb();
    const provider = makeProvider();

    const result = await createPaymentNeverthrow(
      db,
      provider,
      validInput,
      'actor@example.com'
    );

    // Same test pattern for success
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.paymentId).toBe('prov_ref1');
    }
  });
});
```

**Benefits of this approach:**

**1. Uniform test structure for all outcomes**

Every test follows the same pattern: call the function, check if it's Ok or Err, inspect the value or error.

**2. Easy to inspect error details**

Errors are values. You can check properties, compare values, and test multiple error conditions without special syntax.

**3. Simple to test complex failure scenarios**

Want to test cascading failures? Just check the Result chain. Want to test recovery? Check that the error track switches back to success.

### Testing Effect: Maximum Control

```typescript
describe('Effect payment processing', () => {
  it('should work with test implementations', async () => {
    // Create pure test implementations
    const testDb = Layer.effect(
      DbService,
      Effect.succeed({
        findPaymentByKey: () => Promise.resolve(undefined),
        acquireLock: () => Promise.resolve(true),
        transaction: (fn) =>
          fn({
            insertPayment: () => Promise.resolve(),
            insertAudit: () => Promise.resolve(),
          }),
      })
    );

    const testProvider = Layer.effect(
      ProviderService,
      Effect.succeed({
        createPayment: () =>
          Promise.resolve({
            id: 'test_payment',
            status: 'CONFIRMED' as const,
          }),
      })
    );

    const effect = createPaymentEffect(validInput, 'actor@example.com');

    const result = await Effect.runPromise(
      Effect.provide(effect, Layer.merge(testDb, testProvider))
    );

    expect(result.paymentId).toBe('test_payment');
  });
});
```

**Benefits of this approach:**

**1. Complete dependency injection through layers**

No mocking frameworks needed. You provide test implementations directly through layers.

**2. Test policies (timeout, retry) in isolation**

Want to test that your retry logic works? Create a provider that fails twice then succeeds, and verify the effect retries correctly.

**3. Pure test implementations without mocking**

Your test implementations are just objects. No magic, no setup, no teardown.

**4. Predictable test execution without side effects**

Effects are descriptions of work, not the work itself. You can inspect, modify, and test them without running side effects.

## Performance Considerations

### Bundle Size Impact

The first question everyone asks: how much does this cost?

- **try/catch**: Zero additional bundle size (native JavaScript)
- **neverthrow**: Small footprint (~3-5KB minified + gzipped), tree-shakeable
- **Effect**: Larger runtime system (~50KB+ minified + gzipped)

**When bundle size matters:**

If you're building for mobile, edge functions, or environments where every kilobyte counts, try/catch's zero overhead is compelling. neverthrow adds minimal cost. Effect requires justification.

### Runtime Characteristics

**Exceptions are expensive**

When try/catch actually catches exceptions, it's much slower than normal execution. The exact performance depends on:

- How deep the call stack is
- Whether the exception is caught locally or bubbles up
- The JavaScript engine's optimization (V8, SpiderMonkey, etc.)

**But here's the key: exceptions are only expensive when thrown**

If your error rate is truly low (<0.1%), the performance impact is negligible. But if errors are common (validation failures, expected business logic paths), exceptions become costly.

**Result types have consistent performance**

Success and error paths perform similarly, making performance more predictable. Whether you return `ok(value)` or `err(error)`, the cost is roughly the same.

**Effect has overhead**

The runtime system adds consistent overhead but provides more features and better composability. The overhead is usually small compared to actual I/O operations (database, network), but it's there.

### When Performance Matters

**Choose try/catch when:**

- Bundle size is critical (mobile, edge functions)
- Happy path performance is paramount
- Error rates are genuinely low (<0.1%)
- You're at system boundaries where exceptions are expected

**Choose neverthrow when:**

- You need predictable performance
- Error rates are moderate (0.1% to 10%)
- Bundle size is a reasonable concern but not critical
- You want composability without runtime overhead

**Choose Effect when:**

- Complex orchestration outweighs performance cost
- Consistent performance is more important than peak performance
- Bundle size is not a constraint
- You need sophisticated features (retries, timeouts, dependency injection)

## Error Recovery Patterns

### Circuit Breaker Pattern

When external services become unreliable, fail fast to avoid cascading failures:

```typescript
// try/catch: Manual circuit breaker
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > 60000) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  private reset() {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  private recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= 5) {
      this.state = 'OPEN';
    }
  }
}

// neverthrow: Functional circuit breaker
function circuitBreakerResult<T, E extends Error>(
  fn: () => ResultAsync<T, E>,
  config: { threshold: number; timeout: number }
): () => ResultAsync<T, E | CircuitOpenError> {
  let failures = 0;
  let lastFailure = 0;
  let state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';

  return () => {
    if (state === 'OPEN') {
      if (Date.now() - lastFailure > config.timeout) {
        state = 'HALF_OPEN';
      } else {
        return errAsync(new CircuitOpenError('Circuit breaker is OPEN'));
      }
    }

    return fn().match(
      (success) => {
        failures = 0;
        state = 'CLOSED';
        return okAsync(success);
      },
      (error) => {
        failures++;
        lastFailure = Date.now();
        if (failures >= config.threshold) {
          state = 'OPEN';
        }
        return errAsync(error);
      }
    );
  };
}

// Effect: Built-in circuit breaker policy
const circuitBreakerEffect = <T, E>(
  effect: Effect<T, E, never>,
  config: { maxFailures: number; resetTimeout: Duration }
) =>
  effect.pipe(Effect.circuitBreaker(config.maxFailures, config.resetTimeout));
```

**Why circuit breakers matter:**

When a service is failing, continuing to call it wastes resources and increases latency. Circuit breakers fail fast, giving the service time to recover.

### Fallback Strategies

When your primary data source fails, try alternatives before giving up:

```typescript
// neverthrow: Chainable fallbacks
function getDataWithFallback(id: string): ResultAsync<Data, never> {
  return primaryAPI
    .getData(id)
    .orElse(() => {
      console.log('Primary failed, trying cache');
      return cache.get(id);
    })
    .orElse(() => {
      console.log('Cache failed, trying backup API');
      return backupAPI.getData(id);
    })
    .orElse(() => {
      console.log('All sources failed, using default');
      return okAsync({ id, data: null, source: 'default' });
    });
}

// Effect: Policy-based fallbacks
const getDataWithFallbackEffect = (id: string) =>
  primaryAPI.getData(id).pipe(
    Effect.orElse(() =>
      Effect.logInfo('Primary failed, trying cache').pipe(
        Effect.andThen(() => cache.get(id))
      )
    ),
    Effect.orElse(() =>
      Effect.logInfo('Cache failed, trying backup API').pipe(
        Effect.andThen(() => backupAPI.getData(id))
      )
    ),
    Effect.orElse(() =>
      Effect.logInfo('All sources failed, using default').pipe(
        Effect.andThen(() =>
          Effect.succeed({ id, data: null, source: 'default' })
        )
      )
    )
  );
```

**Why fallbacks matter:**

Systems fail. Having multiple data sources increases reliability. The key is making fallback logic explicit and composable.

### Compensation Patterns (Sagas)

When multi-step operations fail partway through, you need to undo what you've done:

```typescript
// neverthrow: Structured compensation
type CompensationAction = () => ResultAsync<void, Error>;

function processOrderWithCompensation(
  order: Order
): ResultAsync<OrderResult, Error> {
  const compensations: CompensationAction[] = [];

  const runCompensations = (): ResultAsync<void, Error> => {
    return Result.combine(
      compensations.reverse().map((action) => action())
    ).map(() => {});
  };

  return processPayment(order.payment)
    .map((payment) => {
      compensations.push(() => refundPayment(payment.id));
      return payment;
    })
    .andThen(() => reserveInventory(order.items))
    .map(() => {
      compensations.push(() => unreserveInventory(order.items));
    })
    .andThen(() => scheduleShipping(order))
    .map(() => ({ success: true, orderId: order.id }))
    .orElse((error) => runCompensations().andThen(() => errAsync(error)));
}

// Effect: STM (Software Transactional Memory)
const processOrderWithSTM = (order: Order) =>
  Effect.gen(function* () {
    return yield* STM.atomically(
      STM.gen(function* () {
        const payment = yield* processPaymentSTM(order.payment);
        yield* reserveInventorySTM(order.items);
        yield* scheduleShippingSTM(order);
        return { success: true, orderId: order.id };
      })
    );
  });
```

**Why compensation patterns matter:**

Distributed transactions are hard. When you can't rely on database transactions, you need explicit compensation logic to maintain consistency.

## Production Battle Stories

### Story 1: The Payment Processor That Learned to Fail Gracefully

**The Problem**

A payment processor was using try/catch everywhere. When their primary payment provider had an outage, the entire service went down because exceptions were bubbling up and crashing request handlers.

**The Solution**

They migrated their core payment logic to neverthrow, allowing them to:

- Implement fallback payment providers
- Gracefully degrade to "payment pending" mode
- Log detailed error information without crashing

**The Result**

99.9% uptime even when individual providers failed. Customer support calls dropped by 80% during provider outages.

### Story 2: The Microservice That Couldn't Scale

**The Problem**

A microservice was handling increasing load but error handling was scattered across try/catch blocks. When they needed to add timeouts, retries, and circuit breakers, the code became unmaintainable.

**The Solution**

They adopted Effect, which allowed them to:

- Declare retry and timeout policies once and reuse them
- Test complex failure scenarios easily
- Add observability without changing business logic

**The Result**

Reduced incident response time from hours to minutes. New features could be added without fear of breaking error handling. The team reported that debugging became significantly easier.

### Story 3: The Legacy Migration That Didn't Break Everything

**The Problem**

A large e-commerce platform wanted to improve error handling but couldn't afford to rewrite their entire system. They had millions of lines of code using try/catch.

**The Solution**

They used the boundary strategy:

- Kept try/catch at HTTP handlers and database layers
- Gradually converted core business logic to neverthrow
- Used wrapper functions to bridge between paradigms

**The Result**

Improved error handling without any customer-facing downtime. The migration took 6 months but was done incrementally, feature by feature.

## The Final Word

Error handling isn't about choosing the "best" approach: it's about choosing the right tool for your specific context. Consider:

**Team expertise**

How comfortable is your team with functional programming? If everyone knows JavaScript but nobody knows functional patterns, neverthrow will require training. Effect even more so.

**System complexity**

How many failure modes do you need to handle? Simple CRUD apps might be fine with try/catch. Complex distributed systems benefit from Effect's sophisticated tooling.

**Performance requirements**

Are milliseconds critical, or is reliability more important? High-frequency trading systems care about nanoseconds. Most web apps care about correctness first.

**Migration constraints**

Are you working with legacy code or starting fresh? Greenfield projects have more flexibility. Legacy systems need gradual migration strategies.

Start simple, evolve gradually, and always remember: the best error handling strategy is the one that helps you sleep better at night.

When your pager goes off at 3 AM because payments are down, you'll thank yourself for thinking this through.

***

For more examples and working code, check out the [src/](./src/) directory.
