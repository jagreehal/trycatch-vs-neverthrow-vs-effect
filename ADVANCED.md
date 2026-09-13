# Advanced Error Handling: The Complete Guide

**Implementation details, migration strategies, and patterns that survived production**

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

We build a payment processing system four ways. It handles real money and cannot afford to lose a penny.

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

`ResultAsync<{paymentId: string}, Error>` tells you what to expect: a payment id or an `Error`, and no hidden exceptions.

**2. Composable**

Chain operations with `andThen`, handle errors with `orElse`. The flow is a pipeline, not a maze of try/catch blocks.

**3. Errors are data**

You can inspect, log, transform, and recover from errors without special syntax. Logging validation errors one way and database errors another is a `switch` on the tag.

**4. Gradual adoption**

Wrap legacy code with `Result.fromThrowable()` and migrate piece by piece. No need to rewrite your entire codebase at once.

### Approach 3: The Orchestrator (Awaitly)

```typescript
import {
  ok,
  err,
  createWorkflow,
  isUnexpectedError,
  retryPolicies,
  type AsyncResult,
} from 'awaitly';

// Type-safe error types
type PaymentError =
  | ValidationError
  | IdempotencyConflict
  | ProviderUnavailable
  | ProviderHardFail
  | PersistError;

// Dependencies with typed Results
const paymentDeps = {
  parse: (raw: unknown): AsyncResult<CreatePayment, ValidationError> => {
    const parsed = CreatePayment.safeParse(raw);
    return parsed.success
      ? Promise.resolve(ok(parsed.data))
      : Promise.resolve(err(new ValidationError(parsed.error.message)));
  },

  findExisting: (
    db: Db,
    idemKey: string
  ): AsyncResult<{ id: string } | null, Error> =>
    db
      .findPaymentByKey(idemKey)
      .then((r) => ok(r ?? null))
      .catch((e) => err(e instanceof Error ? e : new Error(String(e)))),

  acquireLock: (
    db: Db,
    idemKey: string
  ): AsyncResult<boolean, IdempotencyConflict> =>
    db.acquireLock(idemKey).then((locked) =>
      locked ? ok(true) : err(new IdempotencyConflict('Concurrent request'))
    ),

  callProvider: (
    provider: Provider,
    input: CreatePayment
  ): AsyncResult<ProviderResponse, ProviderSoftFail | ProviderHardFail> =>
    provider
      .createPayment({
        amountMinor: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
      })
      .then((r) => ok(r))
      .catch((e: any) => {
        const status = e?.status;
        if (status === 429 || status >= 500) {
          return err(new ProviderSoftFail(`Provider ${status}`));
        }
        if (status >= 400) {
          return err(new ProviderHardFail(`Provider ${status}`));
        }
        return err(new ProviderSoftFail(String(e)));
      }),

  persistSuccess: (
    db: Db,
    actorEmail: string,
    input: CreatePayment,
    resp: ProviderResponse
  ): AsyncResult<string, PersistError> =>
    db
      .transaction(async (tx) => {
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
      })
      .then((id) => ok(id))
      .catch((e) => err(new PersistError(String(e)))),

  persistFailure: (
    db: Db,
    actorEmail: string,
    input: CreatePayment,
    error: Error
  ): AsyncResult<void, PersistError> =>
    db
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
          metadata: { reason: String(error) },
        });
      })
      .then(() => ok(undefined))
      .catch((e) => err(new PersistError(String(e)))),
};

export async function createPaymentAwaitly(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
) {
  const workflow = createWorkflow('payment', paymentDeps);

  return workflow.run(async ({ step, deps }) => {
    // 1) Validate input
    const input = await step('parse', () => deps.parse(raw), {
      description: 'Parse input',
      key: 'parse',
    });

    // 2) Check for existing payment (idempotency)
    const existing = await step('findExisting', () => deps.findExisting(db, input.idemKey), {
      description: 'Check existing',
      key: `existing:${input.idemKey}`,
    });

    if (existing) {
      return { paymentId: existing.id };
    }

    // 3) Acquire lock
    await step('acquireLock', () => deps.acquireLock(db, input.idemKey), {
      description: 'Acquire lock',
      key: `lock:${input.idemKey}`,
    });

    // 4) Call provider with retry and timeout. No try/catch: callProvider
    //    returns a Result, so a soft failure is a value, not an exception.
    //    On a hard failure the step short-circuits and workflow.run resolves
    //    to that error, the boundary decides what to do about it.
    const response = await step.retry(
      'callProvider',
      () => deps.callProvider(provider, input),
      {
        attempts: 3,
        backoff: 'exponential',
        initialDelay: 200,
        maxDelay: 3000,
        jitter: true,
        shouldRetry: (error) => error instanceof ProviderSoftFail,
        timeout: { ms: 5000 },
        key: `provider:${input.idemKey}`,
      }
    );

    // 5) Persist success
    const paymentId = await step(
      'persistSuccess',
      () => deps.persistSuccess(db, actorEmail, input, response),
      {
        description: 'Persist success',
        key: `persist:${input.idemKey}`,
      }
    );

    return { paymentId };
  });
}

// Boundary: the workflow never throws, so failure handling lives in one place
export async function handleCreatePayment(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
) {
  const result = await createPaymentAwaitly(db, provider, raw, actorEmail);
  if (result.ok) return { status: 201, body: result.value };

  if (isUnexpectedError(result.error)) {
    console.error('Bug:', result.error.cause);
    return { status: 500 };
  }

  if (result.error instanceof ProviderSoftFail) return { status: 503 };
  if (result.error instanceof IdempotencyConflict) return { status: 409 };
  return { status: 400 };
}
```

**What makes this work well:**

**1. Familiar async/await syntax**

The code reads like standard JavaScript. No method chaining or generator syntax to learn. A developer new to the codebase can read it on day one.

**2. Built-in retry and timeout**

`step.retry()` handles exponential backoff with jitter out of the box, and takes `timeout` in the same options object. No custom retry logic, no extra library, and no `try`/`catch` around the step. Errors from a step propagate to the workflow result, so wrapping one in `try`/`catch` breaks that guarantee. To convert a *throwing* API into a typed error, `step.try(id, fn, { error | onError, retry?, timeout?, compensate? })` is the one wrapper that does it.

**3. Step caching with keys**

Each step has a `key` parameter. When you resume the workflow after a crash, it skips the steps that completed. Payment processing needs this, because a second charge is the failure you cannot undo.

**4. Automatic error inference**

The workflow computes the union of every error your dependencies can produce, so TypeScript knows the error set without a manual annotation.

**5. Observability built-in**

Since 4.5, runs, steps, retry attempts, parallel and race scopes, and saga compensations emit OpenTelemetry spans on their own. Register a provider once at startup and the workflow structure reaches your tracing backend with no adapter. Each step runs inside its own active span, so spans from clients you already instrument nest under the step that made the call. `onEvent` is still there for logging and debugging hooks that want the raw event stream.

**6. Policy-driven configuration**

Apply pre-built policies for common patterns: `withPolicy(servicePolicies.httpApi)` gives you 5-second timeout with 3 retries. Build consistent reliability across your entire codebase.

**7. Production-grade reliability features**

Circuit breakers, rate limiting, saga compensation, durable execution, and human-in-the-loop orchestration are all built-in. No need to implement these patterns yourself.

### Awaitly Advanced Features

Beyond basic workflows, Awaitly provides a comprehensive suite of production-ready features.

#### Durable Execution

Persist workflow state and resume from any point after a crash or a deployment:

```typescript
import { durable } from 'awaitly/durable';

// Omit store to use default in-memory persistence (per process). Pass a SnapshotStore for cross-restart persistence.
const result = await durable.run(
  { chargeCard, sendReceipt, updateInventory },
  async ({ step, deps }) => {
    // Each keyed step is automatically checkpointed
    const charge = await step('chargeCard', () => deps.chargeCard(payment), {
      key: 'charge',
      description: 'Charge card',
    });

    await step('updateInventory', () => deps.updateInventory(items), {
      key: 'inventory',
      description: 'Update inventory',
    });

    await step('sendReceipt', () => deps.sendReceipt(charge), {
      key: 'receipt',
      description: 'Send receipt',
    });

    return { paymentId: charge.id };
  },
  {
    id: `checkout-${orderId}`,
    version: 1, // Increment when workflow logic changes
  }
);

if (!result.ok && isWorkflowCancelled(result.error)) {
  console.log('Workflow cancelled, state saved for resume');
}
```

**Key features:**
- **Automatic checkpointing**: State saved after each keyed step
- **Crash recovery**: Resume from last completed step on restart
- **Version management**: Reject resume if workflow logic changed
- **Concurrency control**: Prevent duplicate executions of the same workflow ID
- **Drift detection**: A resume whose step order no longer matches the snapshot fails instead of replaying

**Resume safety in Awaitly 4.** Bound step keys are position-derived (`getUser`, `getUser#2`, …), so inserting or reordering a dep call used to shift every later suffix. A resumed run could read a *different* step's checkpoint under the same key and carry on with the wrong value, and avoiding that depended on you remembering to bump `version`.

Snapshots now record the executed step order, and a mismatched resume fails with `WorkflowShapeDriftError`, carrying `workflowId`, `stepIndex`, `expectedStepKey`, and `actualStepKey`, rather than replaying against the wrong checkpoints. The new `onBeforeStep(stepKey, workflowId, context, info)` hook raises it, which fires before every step, including one about to be served from the cache or a snapshot, and before that stored value is read. That is the only point where the hook can still reject a stale checkpoint, since `onAfterStep` never fires for a replayed step:

```typescript
const result = await durable.run(deps, fn, {
  id: `checkout-${orderId}`,
  version: 1,
  store,
  onBeforeStep: (stepKey, workflowId, _ctx, info) => {
    // info.argsFingerprint tells you which arguments a bound step was called
    // with. undefined means "no information", never read it as "unchanged".
    log.debug({ workflowId, stepKey, args: info.argsFingerprint });
  },
});
```

#### Saga Pattern (Automatic Compensation)

Define compensating actions for rollback when downstream steps fail:

```typescript
import { createSagaWorkflow, isSagaCompensationError } from 'awaitly/durable';

const checkout = createSagaWorkflow('checkout', {
  reserveInventory,
  releaseInventory,
  chargeCard,
  refundPayment,
  scheduleShipping,
});

const result = await checkout.run(async ({ step, deps }) => {
  // Step 1: Reserve inventory (with compensation)
  const reservation = await step(
    'Reserve inventory',
    () => deps.reserveInventory(items),
    { compensate: (res) => deps.releaseInventory(res.reservationId) },
  );

  // Step 2: Charge card (with compensation)
  const payment = await step(
    'Charge card',
    () => deps.chargeCard(amount),
    { compensate: (p) => deps.refundPayment(p.transactionId) },
  );

  // Step 3: Schedule shipping (no compensation needed)
  await step('Schedule shipping', () => deps.scheduleShipping(reservation.id));

  return { reservation, payment };
});

// If step 3 fails, compensations run in LIFO order:
// 1. refundPayment (step 2)
// 2. releaseInventory (step 1)

if (!result.ok && isSagaCompensationError(result.error)) {
  console.log('Saga failed, compensations executed:', result.error.compensationErrors);
}
```

**Key features:**
- **LIFO compensation**: Compensations run in reverse order
- **`step(..., { compensate })`**: Execute Result-returning operations with optional compensation
- **`step.try`**: Execute throwing operations with error mapping
- **Compensation error tracking**: Know which compensations failed and why

#### Circuit Breaker

Prevent cascading failures with built-in circuit breaker:

```typescript
import {
  createCircuitBreaker,
  circuitBreakerPresets,
  isCircuitOpenError,
} from 'awaitly';

// Use presets for common scenarios
const paymentBreaker = createCircuitBreaker(
  'payment-provider',
  circuitBreakerPresets.critical // Opens after 3 failures, 60s reset
);

// Or customize
const apiBreaker = createCircuitBreaker('external-api', {
  failureThreshold: 5,
  resetTimeout: 30000,
  windowSize: 60000,
  halfOpenMax: 3,
  onStateChange: (from, to, name) => {
    console.log(`Circuit ${name}: ${from} -> ${to}`);
  },
});

// In workflow
const result = await workflow.run(async ({ step, deps }) => {
  // executeResult returns a Result, no exceptions
  const data = await paymentBreaker.executeResult(() =>
    step('chargeCard', () => deps.chargeCard(payment))
  );

  if (!data.ok && isCircuitOpenError(data.error)) {
    // Circuit is open, fail fast
    console.log(`Retry after ${data.error.retryAfterMs}ms`);
    return err(new ProviderUnavailable('Circuit open'));
  }

  return data;
});
```

**Presets available:**
- `critical`: Opens after 3 failures, recovers after 60s
- `standard`: Balanced (5 failures, 30s reset)
- `lenient`: Opens after 10 failures, recovers after 15s

#### Rate Limiting

Control throughput for rate-limited APIs or shared resources:

```typescript
import {
  createRateLimiter,
  createConcurrencyLimiter,
  createCombinedLimiter,
} from 'awaitly';

// Rate limiting (requests per second)
const apiLimiter = createRateLimiter('stripe-api', {
  maxPerSecond: 10,
  burstCapacity: 20, // Allow brief spikes
  strategy: 'wait', // Wait for slot (vs 'reject')
});

// Concurrency limiting (max concurrent)
const dbLimiter = createConcurrencyLimiter('db-pool', {
  maxConcurrent: 5,
  strategy: 'queue', // Queue requests (vs 'reject')
  maxQueueSize: 100,
});

// Combined for both rate + concurrency control
const limiter = createCombinedLimiter('api', {
  rate: { maxPerSecond: 10 },
  concurrency: { maxConcurrent: 5 },
});

// Usage in workflow
const result = await workflow.run(async ({ step, deps }) => {
  // Rate-limited API call
  const data = await apiLimiter.execute(() =>
    step('callApi', () => deps.callExternalApi())
  );

  // Batch with concurrency control
  const results = await dbLimiter.executeAll(
    ids.map((id) => () => step('fetchItem', () => deps.fetchItem(id)))
  );

  return { data, results };
});
```

#### Policies

Reusable bundles of retry, timeout, and other step options:

```typescript
import {
  servicePolicies,
  retryPolicies,
  timeoutPolicies,
  withPolicy,
  createPolicyRegistry,
} from 'awaitly';

// Pre-built service policies
// servicePolicies.httpApi: 5s timeout, 3 retries with exponential backoff
// servicePolicies.database: 30s timeout, 2 retries
// servicePolicies.cache: 1s timeout, no retry
// servicePolicies.messageQueue: 30s timeout, 5 retries

// Inline policy application
const user = await step(
  'fetchUser',
  () => deps.fetchUser(id),
  withPolicy(servicePolicies.httpApi, { description: 'fetch-user', key: `user:${id}` })
);

// Policy registry for org-wide standards
const registry = createPolicyRegistry();
registry.register('api', servicePolicies.httpApi);
registry.register('db', servicePolicies.database);
registry.register('cache', servicePolicies.cache);

// Use from registry
const data = await step(
  'queryDatabase',
  () => deps.queryDatabase(query),
  registry.apply('db', { description: 'query-users' })
);

// Compose policies
import { mergePolicies } from 'awaitly';

const customPolicy = mergePolicies(
  timeoutPolicies.api, // 5s timeout
  retryPolicies.aggressive, // 5 attempts
  { name: 'critical-call' }
);
```

#### Singleflight (Request Coalescing)

Deduplicate concurrent identical requests:

```typescript
import { singleflight } from 'awaitly';

const fetchUserOnce = singleflight(fetchUser, {
  key: (id) => `user:${id}`,
  ttl: 5000, // Cache successful results for 5 seconds
});

// All concurrent calls share one request
const [user1, user2, user3] = await Promise.all([
  fetchUserOnce('1'), // Triggers fetch
  fetchUserOnce('1'), // Joins existing fetch
  fetchUserOnce('2'), // Different key - new fetch
]);

// After TTL expires, next call triggers fresh fetch
```

**Use cases:**
- Prevent thundering herd on cache miss
- Deduplicate API calls during page load
- Share expensive computations across callers

#### Streaming with Results (Awaitly 4)

`awaitly/durable` provides Result-aware stream processing with transformers and backpressure handling:

```typescript
import { createWorkflow, tryAsync, type AsyncResult } from 'awaitly';
import {
  createMemoryStreamStore,
  createFileStreamStore,
  pipe,
  map,
  filter,
  flatMap,
  chunk,
  take,
  collect,
  reduce,
} from 'awaitly/durable';

// Stream stores are workflow options, step.getReadable/getWritable use them
const streamStore = createMemoryStreamStore();
// const streamStore = createFileStreamStore('./output.txt');

// collect()/reduce() are terminal consumers: they throw rather than returning a
// Result, so a caller who just wants an array gets one. Inside a workflow you
// still get typed errors, see the note under this example.
const collectBatches = (
  source: AsyncIterable<string[]>
): AsyncResult<string[][], 'COLLECT_FAILED'> =>
  tryAsync(() => collect(source), () => 'COLLECT_FAILED');

const workflow = createWorkflow('streamPipeline', { collectBatches }, { streamStore });

await workflow.run(async ({ step, deps }) => {
  const reader = step.getReadable<string>({ namespace: 'input' });
  const writer = step.getWritable<string>({ namespace: 'output' });

  // Data-first transformers, composed with pipe() (up to eight stages since
  // Awaitly 4.1; nest another pipe() for more)
  const processed = pipe(
    reader,
    (s) => map(s, (line) => line.toUpperCase()),
    (s) => filter(s, (line) => line.startsWith('VALID:')),
    (s) => flatMap(s, (line) => line.split(',')), // One-to-many
    (s) => chunk(s, 100) // Batch into arrays of 100
  );
  const limited = take(processed, 1000); // Limit total batches

  const results = await step('collectBatches', () => deps.collectBatches(limited));

  await writer.write(`processed ${results.length} batches`);
  await writer.close();

  return { batches: results.length };
});
```

**How stream failures surface (Awaitly 4.1):**

`reader.read()` models a read failure as a Result, while iterating a reader with `for await`, a transformer, or `collect()` turns it back into a throw. Awaitly sorts the two cases at the workflow boundary:

| What failed | How it arrives |
| --- | --- |
| The stream itself (`STREAM_READ_ERROR`, `STREAM_STORE_ERROR`, ...) | A typed error value in `result.error`, the same treatment `STEP_TIMEOUT` gets, and never wrapped in `UnexpectedError` |
| Your own transform callback threw | `UnexpectedError`, with the original throw on `.cause` |

```typescript
if (!result.ok) {
  switch (result.error.type ?? result.error) {
    case 'STREAM_READ_ERROR': return { status: 503 }; // store is down, retry
    case 'STEP_TIMEOUT': return { status: 504 };
  }
}
```

That split is the point: the library's own failures are values you can act on, and your bugs stay exceptions. To get one into the *static* union so a boundary switch stays exhaustive, declare it like any other error with `createWorkflow(name, deps, { streamStore, errors: ['STREAM_READ_ERROR'] })`. The `tryAsync` wrapper above then covers throws from your own callbacks and nothing else.

**Backpressure Handling:**

```typescript
import { createBackpressureController, shouldApplyBackpressure } from 'awaitly/durable';

const controller = createBackpressureController({
  highWaterMark: 1000,
  onStateChange: (state) => console.log(`Backpressure: ${state}`),
});

// Pause production when buffer is full
for (const item of hugeDataset) {
  if (shouldApplyBackpressure(controller)) {
    await controller.waitForDrain();
  }
  await writable.write(item);
}
```

**Limitations vs Effect Stream:**
- No windowing or complex time-based operations
- Fewer backpressure strategies
- Simpler API trades off some power for familiarity

#### Result Composition and HTTP Boundaries (Awaitly 4)

Awaitly 4 collapses thirteen entry points into four. The release dropped nothing; the exports moved:

| Entry | Contents |
| --- | --- |
| `awaitly` | Result primitives, `run()`, `createWorkflow`, steps, resources, batching, per-dep policies, circuit breaker, rate limiting, cache, durations |
| `awaitly/result` | Result primitives only (minimal bundle) |
| `awaitly/durable` | Durable execution, persistence, sagas, human-in-the-loop, streaming, webhooks, engine |
| `awaitly/testing` | Test utilities (kept out of production bundles) |

Migration map: `awaitly/run`, `awaitly/workflow`, and `awaitly/reliability` → `awaitly`; `awaitly/persistence`, `awaitly/saga`, `awaitly/hitl`, `awaitly/streaming`, `awaitly/webhook`, and `awaitly/engine` → `awaitly/durable`. `awaitly` still re-exports nothing from `awaitly/durable`, so CommonJS and non-tree-shaking consumers do not pull the production graph in through the front door.

Result combinators such as `map`, `andThen`, `all`, and `allAsync` come from the root or `awaitly/result`. Wrap native `fetch` with `tryAsync` and map failures into domain errors.

#### step.sleep() with Duration Support (Awaitly 4)

Cancellation-aware delays with human-readable duration strings:

```typescript
import { run } from 'awaitly';
import { seconds, minutes, hours, days, millis } from 'awaitly';

await run(async ({ step }) => {
  // String duration syntax (human-readable): ID first, then duration
  await step.sleep('delay', '5s');        // 5 seconds
  await step.sleep('delay', '1m');        // 1 minute
  await step.sleep('delay', '1m 30s');    // 1 minute 30 seconds
  await step.sleep('delay', '2h 15m');    // 2 hours 15 minutes
  await step.sleep('delay', '500ms');     // 500 milliseconds

  // Duration helpers (composable)
  await step.sleep('delay', seconds(5));
  await step.sleep('delay', minutes(1));
  await step.sleep('delay', hours(2));
  await step.sleep('delay', millis(500));

  // Combined durations
  await step.sleep('delay', minutes(1) + seconds(30));
});
```

**AbortSignal Cancellation:**

```typescript
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

const result = await run(async ({ step }) => {
  await step.sleep('delay', '10s', { signal: controller.signal });
  return 'completed';
}, { signal: controller.signal });

if (!result.ok) {
  console.log('Sleep was cancelled');
}
```

**Caching with Key:**

```typescript
await run(async ({ step }) => {
  // Rate-limit delay that can be resumed
  await step.sleep('delay', '5s', { key: 'rate-limit-delay' });

  // If workflow resumes, cached sleeps are skipped
  // (the delay is considered "already waited")
});
```

**Use Cases:**
- Rate limiting between API calls
- Polling with backoff
- Scheduled tasks within workflows
- Graceful shutdown with timeout

#### Lint Plugin (eslint-plugin-awaitly v4.0.0, under ESLint or oxlint)

Catch common Awaitly mistakes at lint time. The plugin is written against the ESLint rule API, and oxlint loads it unchanged through `jsPlugins`, which is how this repo runs it. The config below is the ESLint form; the oxlint form in [`.oxlintrc.json`](./.oxlintrc.json) lists the same rules under the same names.

Two rules are **gone** in v3: `workflow-prefer-step-if` and `workflow-prefer-step-foreach`. They existed only because the analyzer could not identify a raw `if` or `for...of` branch, so diagrams needed `step.if` / `step.forEach` wrappers to stay readable. Awaitly 4's analyzer derives a stable id from the branch's own expression (`user.isPremium` → `user-is-premium`), so plain control flow is diagrammable and the wrappers stopped earning their keep. Derivation stays conservative: an expression it cannot encode without loss, such as a call or arithmetic, yields no id and the node stays unlabelled. If your config still lists either rule, delete the entry: both linters error on unknown rule names.

```javascript
// eslint.config.mjs
import awaitlyPlugin from 'eslint-plugin-awaitly';

export default [
  {
    files: ['**/*.ts'],
    plugins: { awaitly: awaitlyPlugin },
    rules: {
      // Prevents step(fn()) - must be step(() => fn())
      'awaitly/step-no-immediate-execution': 'error',

      // Requires thunk when using key option (for caching)
      'awaitly/step-require-thunk-for-key': 'error',

      // Warns about dynamic cache keys that may cause issues
      'awaitly/step-stable-cache-keys': 'warn',

      // Ensures workflows are awaited (no floating promises)
      'awaitly/workflow-no-floating': 'error',

      // Ensures Results are handled (like neverthrow/must-use-result)
      'awaitly/result-no-floating': 'error',

      // Enforces .ok checks before accessing .value
      'awaitly/result-require-handling': 'warn',

      // Prevents options on executor instead of step
      'awaitly/workflow-options-position': 'error',

      // Prevents ok(ok(...)) double wrapping
      'awaitly/result-no-double-wrap': 'error',

      // Catches a workflow that registers deps then calls the module-level
      // function anyway, defeating run(fn, { deps })
      'awaitly/step-no-deps-bypass': 'error',

      // New in 3.2: an Error subclass with no string-literal `type` or `_tag`
      // collapses into its siblings in an inferred error union
      'awaitly/error-require-discriminant': 'error',
    },
  },
];
```

```jsonc
// .oxlintrc.json: same rules, loaded as a JS plugin, with tsgolint for type-aware rules
{
  "jsPlugins": ["eslint-plugin-awaitly"],
  "options": { "typeAware": true },
  "rules": {
    "awaitly/step-no-immediate-execution": "error",
    "awaitly/result-no-floating": "error",
    "awaitly/error-require-discriminant": "error"
  }
}
```

**Rule Details:**

| Rule | Description | Fixable |
|------|-------------|---------|
| `step-no-immediate-execution` | Prevents `step(fn())` which executes immediately, not lazily | No |
| `step-require-thunk-for-key` | Requires `step(() => fn(), { key })` when using cache key | No |
| `step-stable-cache-keys` | Warns about `key: \`user:${Math.random()}\`` patterns | No |
| `step-no-deps-bypass` | Catches a workflow that registers deps then calls the module-level function anyway | No |
| `workflow-no-floating` | Ensures `createWorkflow(...)` is awaited | No |
| `result-no-floating` | Ensures `Result` values are checked or used | No |
| `result-require-handling` | Warns when accessing `.value` without `.ok` check | No |
| `workflow-options-position` | Prevents `workflow.run(async ({ step }) => {}, { retry })` | Yes |
| `result-no-double-wrap` | Prevents `ok(ok(value))` or `err(err(e))` | Yes |
| `error-require-discriminant` | Reports an `Error` subclass with no string-literal `type` or `_tag`, which collapses into its siblings in an inferred union | No |

That is ten of the twenty-two rules. `recommended` turns on the safety set, and `recommended-strict` adds the rest, including `error-require-discriminant`. Since 4.0 the plugin resolves `step` and `deps` through lexical scopes, so `const { step: s } = ctx` still gets linted, and the `concurrency-no-promise-*` rules fire only inside workflow callbacks.

**Example Violations:**

```typescript
// ❌ step-no-immediate-execution
await step('getUser', fetchUser('1')); // Executes immediately!
// ✅ Fix
await step('getUser', () => fetchUser('1'));

// ❌ step-require-thunk-for-key
await step('getUser', deps.fetchUser('1'), { key: 'user' }); // Can't cache without thunk
// ✅ Fix
await step('getUser', () => deps.fetchUser('1'), { key: 'user' });

// ❌ result-no-floating
const result = await fetchUser('1');
console.log(result.value); // Might be undefined!
// ✅ Fix
const result = await fetchUser('1');
if (result.ok) {
  console.log(result.value);
}

// ❌ result-no-double-wrap
return ok(ok(value)); // Double wrapped!
// ✅ Fix
return ok(value);
```

**Limitations:**
- Some rules are heuristic and can report false positives
- Needs ESLint 9 flat config, or oxlint with `jsPlugins`

#### Human-in-the-Loop (HITL)

Pause workflows for human approval and resume after:

```typescript
import {
  createHITLOrchestrator,
  createMemoryApprovalStore,
  createMemoryWorkflowStateStore,
  createApprovalStep,
} from 'awaitly/durable';

const orchestrator = createHITLOrchestrator({
  approvalStore: createMemoryApprovalStore(),
  workflowStateStore: createMemoryWorkflowStateStore(),
  notificationChannel: {
    onApprovalNeeded: async (ctx) => {
      await sendSlackMessage(`Approval needed: ${ctx.reason}`);
    },
  },
});

// Create approval step factory
const requireManagerApproval = createApprovalStep<{ approvedBy: string }>({
  key: (orderId) => `order-approval:${orderId}`,
  checkApproval: createApprovalChecker(orchestrator.approvalStore),
  pendingReason: 'Waiting for manager approval',
});

// Execute workflow
const result = await orchestrator.execute(
  'high-value-order',
  ({ resumeState, onEvent }) =>
    createWorkflow('high-value-order', deps, { resumeState, onEvent }),
  async ({ step, deps, args: input }) => {
    const order = await step('createOrder', () => deps.createOrder(input));

    // Pause for approval if order > $10,000
    if (order.total > 10000) {
      const approval = await requireManagerApproval(step, order.id);
      await step('logApproval', () => deps.logApproval(order.id, approval.approvedBy));
    }

    await step('processOrder', () => deps.processOrder(order.id));
    return { orderId: order.id };
  },
  { items: [...], total: 15000 }
);

if (result.status === 'paused') {
  console.log(`Waiting for: ${result.pendingApprovals}`);
  // Workflow state is persisted, can resume later
}

// Later, when manager approves via webhook or UI:
await orchestrator.grantApproval(
  `order-approval:${orderId}`,
  { approvedBy: 'manager@example.com' },
  { autoResume: true } // Automatically resume waiting workflows
);
```

**Key features:**
- **Workflow pausing**: Workflows pause at approval steps and resume after
- **State persistence**: Awaitly saves workflow state when a run pauses
- **Notification channels**: Integrate with Slack, email, or custom UIs
- **Webhook handlers**: Built-in handlers for approval/rejection endpoints

### Approach 4: The Architect (Effect)

```typescript
import { Effect, Layer, Context, Schedule, Duration } from 'effect';
import * as STM from 'effect/STM';

// Service tags for dependency injection
export const DbService = Context.Service<Db>('DbService');
export const ProviderService = Context.Service<Provider>('ProviderService');

const retrySchedule = Schedule.exponential(Duration.millis(200)).pipe(
  Schedule.jittered,
  Schedule.upTo({ duration: Duration.seconds(3), times: 2 })
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
      Effect.timeoutOrElse({
        duration: Duration.millis(2000),
        orElse: () => Effect.fail(new TimeoutError('Timed out after 2000ms')),
      }),
      Effect.retry({
        schedule: retrySchedule,
        while: (err: unknown) =>
          err instanceof TimeoutError || err instanceof ProviderSoftFail,
      })
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
      Effect.catch((error) => {
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

You declare timeouts, retries, and logging up front as policies, and you can see, test, and change each one on its own.

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
2. **EVACUATION!** Normal execution stops at that line
3. **SEARCH FOR SAFETY!** The runtime looks up the call stack for a catch block
4. **HANDLE OR PANIC!** Either someone catches it, or the whole program crashes

This works well when failures are rare. Once they turn routine, like network timeouts and validation errors, you set off a fire alarm for events you expected.

**The problem with fire alarms for routine events:**

Throwing an exception forces the runtime to:
- Unwind the call stack
- Search for a handler
- Lose context about where you were
- Make recovery harder than it needs to be

### neverthrow: The Railway Model

Imagine every function as a railway junction with two tracks:

- **Success Track**: When everything works, the train stays on this track
- **Error Track**: When something fails, the train switches to this track

Once you're on the error track, you stay there until you handle the error and switch back to success. Error flow becomes visible and composable.

```typescript
// Each operation is a junction
validateInput(data) // Might switch to error track
  .andThen(checkDuplicates) // Only runs if on success track
  .andThen(callProvider) // Only runs if still on success track
  .orElse(handleError); // Handles error track
```

**Why this works better for business logic:**

The railway model makes failure a first-class concept. You can see the success path and the error path. You can handle specific errors at specific points. And you can compose operations without losing error information.

### Awaitly usage levels

Awaitly stacks three optional layers. You can stop at any one.

| Level | Import | When |
|-------|--------|------|
| Results only | `awaitly` or `awaitly/result` | Drop-in neverthrow alternative |
| Composition | Manual checks + `ErrorsOf`, or `run(deps, fn)` | Async sequential work without workflows |
| Orchestration | `createWorkflow`, `durable` | Caching, resume, HITL, policies |

Entry points:

| Module | Purpose |
|--------|---------|
| `awaitly` | `ok`, `err`, combinators, `tryAsync`, `run`, `createWorkflow`, step helpers |
| `awaitly/result` | Result primitives only, for the minimal-bundle case |
| `awaitly/durable` | Persist and resume workflows, sagas, HITL, streaming, webhooks, engine |
| `awaitly/testing` | `unwrapOk`, `unwrapErr`, harnesses, `testWorkflow` |

See [api-comparison.md](./src/comparison/api-comparison.md) for Level 1 and 2 examples.

### Awaitly: The Conductor Model (Level 3)

At Level 3, you coordinate dependencies through `step()` inside `run()` or `createWorkflow()`. Levels 1 and 2 do not require this model.

- **The Score**: Your workflow function is the sheet music
- **The Musicians**: You inject dependencies and call them through `step()`
- **House Rules (Policies)**: You set timeouts, retries, and rate limits before the performance
- **Skip Failing Sections (Circuit Breakers)**: If a section keeps failing, skip it until it recovers
- **Control Section Tempo (Rate Limiting)**: Ensure sections don't play too fast for the venue
- **Pause for Conductor's Signal (HITL)**: Wait for approval before critical movements
- **Undo Movements (Saga Compensations)**: If the finale fails, undo earlier movements in reverse
- **Early Exit**: If any musician misses their cue (error), the performance stops
- **Caching**: You can mark certain passages to avoid repeating them
- **Resume**: If the concert is interrupted, you can restart from the last completed movement

```typescript
// The conductor coordinates the performance
workflow.run(async ({ step, deps }) => {
  const user = await step('fetchUser', () => deps.fetchUser(id));    // Violin section
  const posts = await step('fetchPosts', () => deps.fetchPosts(id));  // Brass section
  return { user, posts };                                // Final bow
});
```

**Why this model works:**

It combines the familiarity of async/await with the safety of Result types. You write code that looks like standard JavaScript, and the types track the errors, the steps carry the retries, and the workflow resumes.

**The full orchestra:**

When you need production-grade reliability, the conductor has access to a full ensemble of tools:

```typescript
// The full orchestra
const saga = createSagaWorkflow('apiCall', deps); // Automatic compensation
const breaker = createCircuitBreaker('api'); // Fail-fast protection
const limiter = createRateLimiter('api', { maxPerSecond: 10 }); // Tempo control

await saga.run(async ({ step, deps }) => {
  // Rate-limited, circuit-protected, compensating steps
  const data = await limiter.execute(() =>
    breaker.executeResult(() =>
      step('callApi', () => deps.callApi(), {
        compensate: (d) => deps.rollback(d.id),
      }),
    ),
  );
  return data;
});
```

### Effect: The Blueprint Model

Effect treats your program like architectural blueprints:

1. **Description**: You describe what should happen, not how
2. **Policies**: You declare policies (timeouts, retries, etc.) apart from the logic
3. **Dependencies**: You specify what services you need
4. **Execution**: The runtime figures out how to make it happen

This separation lets you test, change, and reason about each concern on its own.

**Why blueprints matter:**

When you separate description from execution, you gain:
- The ability to test without side effects
- The ability to modify policies without changing business logic
- The ability to visualize and reason about your program structure
- Swapping implementations (test vs production) with one layer

## Migration Strategies

### The Four-Phase Evolution

**Phase 1: Foundation (try/catch everywhere)**

Start here. Build basic functionality, ship features, identify pain points where errors are hard to handle. Keep it simple until simplicity becomes painful.

**When to move to Phase 2:**
- You're writing the same error handling patterns in file after file
- You're forgetting to catch errors and finding out at runtime
- Your error handling code is as complex as your business logic
- You need to compose operations but try/catch makes it painful

**Phase 2: Core Domain (introduce Result types)**

Refactor your most complex business logic to use Result types (neverthrow or Awaitly). Keep try/catch at system boundaries (HTTP handlers, event listeners, etc.). Expand the Result-based code one module at a time.

**Choosing between neverthrow and Awaitly:**
- **neverthrow**: If your team likes functional chaining (`.andThen().map()`) and you don't need retry/timeout built-in
- **Awaitly Level 1**: Same Result model as neverthrow (`ok`/`err`, combinators). No workflows required.
- **Awaitly Level 3**: Add `run()`/`createWorkflow` when caching, resume, or policies appear

Both libraries let you move one function at a time, which is what makes this phase safe. Awaitly keeps the call site on `await` and adds a check, so the surrounding code and your team's mental model stay as they were:

```typescript
// Before: a promise that throws
const user = await fetchUser(id);

// After: a Result, still awaited
const result = await fetchUser(id);
if (!result.ok) return result;
const user = result.value;
```

Functions you haven't converted keep working, so you can stop the migration at any point and ship.

**When to move to Phase 3:**
- You need consistent policies (timeouts, retries) across your app
- You're implementing the same infrastructure patterns in service after service
- Testing requires complex mocking and setup
- Your team is comfortable with functional programming concepts

**Phase 3: Policies (consider Effect or Awaitly's advanced features)**

If you chose Awaitly, you may already have what you need in retries, timeouts, circuit breakers, and tracing. Reach for Effect when you need layers or structured concurrency.

**Phase 4: Full Architecture (Effect)**

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

// Wrapper for Awaitly consumers
export async function createUserSafeAwaitly(
  data: unknown
): AsyncResult<User, Error> {
  try {
    const user = await legacyCreateUser(data);
    return ok(user);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

// Now you can compose it
const result = createUserSafe(userData)
  .andThen((user) => validateUser(user))
  .andThen((user) => sendWelcomeEmail(user));
```

**Why this works:**

You get the benefits of Result types in new code without rewriting everything. You can migrate one piece at a time, testing each as you go.

#### 2. The Boundary Strategy

Keep try/catch at your system boundaries and use Result types inside them:

```typescript
// Edge: HTTP handler (try/catch)
export async function POST_createPayment(req: Request, res: Response) {
  try {
    // Internal: Use neverthrow or Awaitly
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

// Awaitly → try/catch
async function callAwaitlyFromTryCatch() {
  const result = await createPaymentAwaitly(db, provider, data, actor);

  if (!result.ok) {
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

// try/catch → Awaitly
async function wrapLegacyForAwaitly(data: unknown): AsyncResult<User, Error> {
  try {
    return ok(await legacyCreateUser(data));
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
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

Checking error details or several error conditions takes nested try/catch blocks or special matchers.

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

To test cascading failures, check the Result chain. To test recovery, check that the error track switches back to success.

### Testing Awaitly: Event-Driven Verification

```typescript
describe('awaitly payment processing', () => {
  it('should handle validation errors', async () => {
    const db = makeDb();
    const provider = makeProvider();

    const result = await createPaymentAwaitly(
      db,
      provider,
      { clientId: '' }, // Invalid input
      'actor@example.com'
    );

    // Same uniform pattern as neverthrow
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
    }
  });

  it('should create payment successfully', async () => {
    const db = makeDb();
    const provider = makeProvider();

    const result = await createPaymentAwaitly(
      db,
      provider,
      validInput,
      'actor@example.com'
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.paymentId).toBe('prov_ref1');
    }
  });

  it('should track all steps via events', async () => {
    const events: any[] = [];
    const workflow = createWorkflow('payment', paymentDeps, {
      onEvent: (event) => events.push(event),
    });

    await workflow.run(async ({ step, deps }) => {
      // ... workflow logic
    });

    // Verify step execution order
    expect(events.filter((e) => e.type === 'step_success').map((e) => e.name))
      .toEqual(['Parse input', 'Check existing', 'Acquire lock', 'Call provider', 'Persist success']);
  });

  it('should retry on soft failures', async () => {
    let attempts = 0;
    const flakyProvider = {
      createPayment: async () => {
        attempts++;
        if (attempts < 3) throw new ProviderSoftFail('Temporarily unavailable');
        return { id: 'prov_123', status: 'CONFIRMED' as const };
      },
    };

    const result = await createPaymentAwaitly(
      db,
      flakyProvider,
      validInput,
      'actor@example.com'
    );

    expect(attempts).toBe(3); // Retried twice before success
    expect(result.ok).toBe(true);
  });

  it('should resume from cached steps', async () => {
    const collector = createResumeStateCollector();

    // First run: fail at persist step
    const workflow1 = createWorkflow('payment', paymentDeps, {
      onEvent: collector.handleEvent,
    });

    // ... simulate failure after provider call
    const savedState = collector.getResumeState();

    // Second run: resume from saved state
    const workflow2 = createWorkflow('payment', paymentDeps, {
      resumeState: savedState,
    });

    // Provider call should be skipped (cached)
    const result = await workflow2(/* ... */);
    expect(result.ok).toBe(true);
  });
});
```

#### Testing Saga Compensation

```typescript
import { createSagaWorkflow, isSagaCompensationError } from 'awaitly/durable';

describe('saga compensation', () => {
  it('should run compensations in LIFO order on failure', async () => {
    const compensationOrder: string[] = [];

    const saga = createSagaWorkflow('compensationOrder', {
      step1: () => Promise.resolve(ok({ id: '1' })),
      step2: () => Promise.resolve(ok({ id: '2' })),
      step3: () => Promise.resolve(err(new Error('Step 3 failed'))),
    });

    const result = await saga.run(async ({ step, deps }) => {
      await step('step1', () => deps.step1(), {
        compensate: () => {
          compensationOrder.push('step1');
        },
      });
      await step('step2', () => deps.step2(), {
        compensate: () => {
          compensationOrder.push('step2');
        },
      });
      await step('step3', () => deps.step3()); // This fails
      return 'done';
    });

    expect(result.ok).toBe(false);
    // Compensations run in reverse order
    expect(compensationOrder).toEqual(['step2', 'step1']);
  });

  it('should track compensation failures', async () => {
    const saga = createSagaWorkflow('compensationFailures', {
      step1: () => ok({}),
      step2: () => err(new Error('fail')),
    });

    const result = await saga.run(async ({ step, deps }) => {
      await step('step1', () => deps.step1(), {
        compensate: () => {
          throw new Error('Compensation failed');
        },
      });
      await step('step2', () => deps.step2());
      return 'done';
    });

    expect(result.ok).toBe(false);
    if (!result.ok && isSagaCompensationError(result.error)) {
      expect(result.error.compensationErrors.length).toBe(1);
    }
  });
});
```

#### Testing Durable Execution

```typescript
import { durable, isWorkflowCancelled } from 'awaitly/durable';

describe('durable execution', () => {
  it('should resume from last completed step', async () => {
    const callCounts = { step1: 0, step2: 0 };

    // First run: complete step1, then "crash"
    const controller = new AbortController();
    const result1 = await durable.run(
      {
        step1: () => { callCounts.step1++; return ok({ id: '1' }); },
        step2: () => {
          controller.abort(); // Simulate crash
          return ok({ id: '2' });
        },
      },
      async ({ step, deps }) => {
        await step('step1', () => deps.step1(), { key: 'step1' });
        await step('step2', () => deps.step2(), { key: 'step2' });
        return 'done';
      },
      { id: 'test-workflow', signal: controller.signal }
    );

    expect(isWorkflowCancelled(result1.error)).toBe(true);
    expect(callCounts.step1).toBe(1);

    // Resume: step1 should be skipped (in-memory store shares state for same id)
    const result2 = await durable.run(
      {
        step1: () => { callCounts.step1++; return ok({ id: '1' }); },
        step2: () => { callCounts.step2++; return ok({ id: '2' }); },
      },
      async ({ step, deps }) => {
        await step('step1', () => deps.step1(), { key: 'step1' });
        await step('step2', () => deps.step2(), { key: 'step2' });
        return 'done';
      },
      { id: 'test-workflow' }
    );

    expect(result2.ok).toBe(true);
    expect(callCounts.step1).toBe(1); // Not called again
    expect(callCounts.step2).toBe(1);
  });
});
```

#### Testing Circuit Breaker

```typescript
import { createCircuitBreaker, isCircuitOpenError } from 'awaitly';

describe('circuit breaker', () => {
  it('should open after threshold failures', async () => {
    const breaker = createCircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeout: 1000,
    });

    // Fail 3 times to open the circuit
    for (let i = 0; i < 3; i++) {
      await breaker.executeResult(() => err(new Error('fail')));
    }

    expect(breaker.getState()).toBe('OPEN');

    // Next call should fail with CircuitOpenError
    const result = await breaker.executeResult(() => ok('success'));
    expect(result.ok).toBe(false);
    expect(isCircuitOpenError(result.error)).toBe(true);
  });

  it('should transition to HALF_OPEN after reset timeout', async () => {
    const breaker = createCircuitBreaker('test', {
      failureThreshold: 1,
      resetTimeout: 50, // 50ms for fast test
    });

    await breaker.executeResult(() => err(new Error('fail')));
    expect(breaker.getState()).toBe('OPEN');

    await new Promise((r) => setTimeout(r, 60));
    // Trigger state check
    await breaker.executeResult(() => ok('success'));
    expect(breaker.getState()).toBe('CLOSED');
  });
});
```

#### Testing HITL Approvals

```typescript
import {
  createHITLOrchestrator,
  createMemoryApprovalStore,
  createMemoryWorkflowStateStore,
} from 'awaitly/durable';

describe('human-in-the-loop', () => {
  it('should pause workflow at approval step', async () => {
    const orchestrator = createHITLOrchestrator({
      approvalStore: createMemoryApprovalStore(),
      workflowStateStore: createMemoryWorkflowStateStore(),
    });

    const result = await orchestrator.execute(
      'test-workflow',
      ({ resumeState, onEvent }) => createWorkflow('test-workflow', deps, { resumeState, onEvent }),
      async ({ step, deps, args: input }) => {
        await step('createOrder', () => deps.createOrder(input));
        // This step will pause for approval
        await step('pendingApproval', () => pendingApproval('Needs manager approval'));
        return 'completed';
      },
      { orderId: '123' }
    );

    expect(result.status).toBe('paused');
    expect(result.pendingApprovals.length).toBeGreaterThan(0);
  });

  it('should resume after approval granted', async () => {
    const approvalStore = createMemoryApprovalStore();
    const orchestrator = createHITLOrchestrator({
      approvalStore,
      workflowStateStore: createMemoryWorkflowStateStore(),
    });

    // Execute and pause
    const paused = await orchestrator.execute(/* ... */);
    const approvalKey = paused.pendingApprovals[0];

    // Grant approval
    await orchestrator.grantApproval(approvalKey, { approvedBy: 'manager' });

    // Resume
    const resumed = await orchestrator.resume(paused.runId, /* ... */);
    expect(resumed.status).toBe('completed');
  });
});
```

**Benefits of this approach:**

**1. Uniform test structure (like neverthrow)**

Check `result.ok`, inspect value or error. Consistent across all tests.

**2. Event stream for observability testing**

Verify that steps executed in the right order, with the right timing, and with proper retry behavior.

**3. Easy to test retry logic**

Create flaky dependencies and verify the workflow retries the right number of times.

**4. Resume state testing**

Interrupt a workflow, resume it, and verify no step ran twice.

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

No mocking frameworks needed. You provide test implementations through layers.

**2. Test policies (timeout, retry) in isolation**

Want to test that your retry logic works? Create a provider that fails twice then succeeds, and verify the effect retries twice.

**3. Pure test implementations without mocking**

Your test implementations are plain objects, with no setup or teardown.

**4. Predictable test execution without side effects**

Effects are descriptions of work, not the work itself. You can inspect, modify, and test them without running side effects.

### Feature Comparison: Awaitly vs Effect

Both Awaitly and Effect provide production-grade reliability features, but with different philosophies:

| Feature | Awaitly | Effect |
|---------|---------|--------|
| **Syntax** | async/await + `step()` | Functional composition with generators |
| **Learning curve** | Familiar to JS developers | Requires functional programming knowledge |
| **Saga Pattern** | `createSagaWorkflow` (first-class) | Manual via effect handlers |
| **Durable Execution** | `durable.run` (built-in) | Custom persistence adapters |
| **Circuit Breaker** | `createCircuitBreaker` with presets | Custom implementation required |
| **Rate Limiting** | `createRateLimiter`, `createConcurrencyLimiter` | Custom implementation required |
| **Policies** | `servicePolicies` + registry | Via `Schedule` |
| **Human-in-the-Loop** | `createHITLOrchestrator` (built-in) | Custom implementation required |
| **Singleflight** | `singleflight()` with TTL caching | Custom implementation required |
| **Streaming** | `awaitly/durable` with transformers | Effect Stream (more powerful) |
| **Result composition** | Root/result combinators | Built-in pipe/flow |
| **HTTP Client** | Native `fetch` wrapped with `tryAsync` | HttpClient (more configurable) |
| **Sleep/Duration** | `step.sleep('id', '5s')` | `Effect.sleep(Duration.seconds(5))` |
| **Lint Plugin** | `eslint-plugin-awaitly` v4.0 (22 rules, ESLint or oxlint) | `@effect/eslint-plugin`, or `@effect/tsgo` diagnostics through `tsc` |
| **Dependency Injection** | Dependencies object to workflow | Layers and Context |
| **Structured Concurrency** | Via `step.all()` | Built-in with fibers |
| **Observability** | Automatic OpenTelemetry spans, plus an `onEvent` callback | Built-in tracing and metrics |
| **Bundle Size** | ~8-15KB (tree-shakeable) | ~50KB+ |

**When to choose Awaitly:**
- Team familiar with async/await, less with FP
- Need production reliability features out of the box
- Want saga pattern and HITL without custom code
- Bundle size matters but you need more than neverthrow

**When to choose Effect:**
- Team comfortable with functional programming
- Need dependency injection with layers
- Want structured concurrency with fiber semantics
- Building complex domain models with type-safe errors

## Performance Considerations

### Bundle Size Impact

The first question everyone asks: how much does this cost? Measured with esbuild 0.28 (`--bundle --minify`, ESM), importing only the names on each line:

| What you import | Minified | Gzipped |
|-----------------|----------|---------|
| try/catch (native JavaScript) | 0 | 0 |
| `awaitly/result` (`ok`, `err`) | 3.5 KB | 1.31 KB |
| `neverthrow` (`ok`, `err`) | 6.4 KB | 1.94 KB |
| `awaitly` (Results, `run`, `createWorkflow`, `tryAsync`, `allAsync`) | 61.9 KB | 18.1 KB |
| `effect` (`Effect.succeed` alone) | 79.6 KB | 27.9 KB |

Reproduce these by bundling a file that imports only those names. Your own number depends on how much of each library you touch, since all three set `sideEffects: false` and tree-shake.

**When bundle size matters:**

On mobile, in edge functions, and anywhere kilobytes are budgeted, try/catch's zero overhead is hard to beat. neverthrow stays tiny and does a lot with it. Awaitly starts smaller still if you import `awaitly/result`, and grows as you pull in workflows, retries, and caching, so you can defer that cost until a feature needs it. Effect's figure reflects a runtime rather than a helper library, and it buys structured concurrency, layers, and scheduling that the others do not attempt. Weigh it against what you would otherwise build by hand.

### Runtime Characteristics

**Exceptions are expensive**

Catching an exception costs far more than a normal return. How much depends on:

- How deep the call stack is
- Whether the exception is caught in the same function or bubbles up
- The JavaScript engine's optimization (V8, SpiderMonkey, etc.)

**The key point: exceptions are only expensive when thrown**

At an error rate below 0.1% you will not measure the difference. Once errors turn routine, as with validation failures and expected business paths, exceptions start costing you.

**Result types have consistent performance**

Success and error paths cost about the same, which makes performance predictable. Returning `ok(value)` or `err(error)` allocates one small object either way. This applies to both neverthrow and Awaitly.

**Awaitly has step overhead**

Each `step()` call adds a small overhead for caching checks, event emission, and error handling. Next to a database or network call it disappears, and it is there.

**Effect has overhead**

The runtime system adds consistent overhead but provides more features and better composability. Next to a database or network call it is small, and it is there.

### When Performance Matters

**Choose try/catch when:**

- Bundle size is critical (mobile, edge functions)
- Happy path performance is paramount
- Error rates stay below 0.1%
- You're at system boundaries where exceptions are expected

**Choose neverthrow when:**

- You need predictable performance
- Error rates are moderate (0.1% to 10%)
- Bundle size is a reasonable concern but not critical
- You want composability without runtime overhead
- You prefer functional chaining style

**Choose Awaitly when:**

- You need retries, timeouts, and caching built-in
- Predictable performance matters
- Bundle size is not critical but not unlimited
- You prefer async/await syntax
- You need workflow resume or observability

**Choose Effect when:**

- Complex orchestration outweighs performance cost
- Consistent performance is more important than peak performance
- Bundle size is not a constraint
- You need layers, structured concurrency, or fibers

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

// Awaitly: Built-in circuit breaker with presets
import {
  createCircuitBreaker,
  circuitBreakerPresets,
  isCircuitOpenError,
} from 'awaitly';

// Use presets for common scenarios
const breaker = createCircuitBreaker('external-api', circuitBreakerPresets.standard);

// Or customize
const customBreaker = createCircuitBreaker('payment-api', {
  failureThreshold: 5,
  resetTimeout: 60000,
  windowSize: 60000,
  halfOpenMax: 3,
  onStateChange: (from, to, name) => console.log(`${name}: ${from} -> ${to}`),
});

const result = await workflow.run(async ({ step, deps }) => {
  // executeResult returns a Result, integrates cleanly with workflows
  const data = await breaker.executeResult(() =>
    step('callExternalService', () => deps.callExternalService())
  );

  if (!data.ok && isCircuitOpenError(data.error)) {
    return err(new ServiceUnavailable(`Retry after ${data.error.retryAfterMs}ms`));
  }

  return data;
});

// Effect: no circuit breaker ships in the core package, so you build one
// from the pieces it does give you: a Ref for the state, and Clock for the
// reset window.
const circuitBreakerEffect = <T, E>(
  effect: Effect.Effect<T, E>,
  config: { maxFailures: number; resetTimeout: Duration.Duration },
  state: Ref.Ref<{ failures: number; openedAt: number | null }>
) =>
  Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const now = yield* Clock.currentTimeMillis;

    if (
      current.openedAt !== null &&
      now - current.openedAt < Duration.toMillis(config.resetTimeout)
    ) {
      return yield* Effect.fail('CIRCUIT_OPEN' as const);
    }

    return yield* effect.pipe(
      Effect.tap(() => Ref.set(state, { failures: 0, openedAt: null })),
      Effect.tapError(() =>
        Ref.update(state, (s) => {
          const failures = s.failures + 1;
          return {
            failures,
            openedAt: failures >= config.maxFailures ? now : s.openedAt,
          };
        })
      )
    );
  });
```

This is the one place in the comparison where the two libraries are not answering the same question with different syntax. Awaitly ships a breaker with presets, half-open probing, and a rolling window. Effect gives you `Ref`, `Clock`, and `Schedule`, which is enough to build one shaped to your service, and community packages exist for the common shape.

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

// Awaitly: Imperative fallbacks with logging
const getDataWithFallbackAwaitly = createWorkflow('getDataWithFallback', {
  primaryAPI,
  cache,
  backupAPI,
});

const result = await getDataWithFallbackAwaitly.run(async ({ step, deps }) => {
  // Try primary
  const primaryResult = await deps.primaryAPI.getData(id);
  if (primaryResult.ok) return primaryResult.value;

  console.log('Primary failed, trying cache');
  const cacheResult = await deps.cache.get(id);
  if (cacheResult.ok) return cacheResult.value;

  console.log('Cache failed, trying backup API');
  const backupResult = await deps.backupAPI.getData(id);
  if (backupResult.ok) return backupResult.value;

  console.log('All sources failed, using default');
  return { id, data: null, source: 'default' };
});

// Effect: Policy-based fallbacks
const getDataWithFallbackEffect = (id: string) =>
  primaryAPI.getData(id).pipe(
    // Effect 4: `orElse` is gone. `catch` takes the error and returns the
    // next effect, which covers the same fallback chain.
    Effect.catch(() =>
      Effect.logInfo('Primary failed, trying cache').pipe(
        Effect.andThen(() => cache.get(id))
      )
    ),
    Effect.catch(() =>
      Effect.logInfo('Cache failed, trying backup API').pipe(
        Effect.andThen(() => backupAPI.getData(id))
      )
    ),
    Effect.catch(() =>
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

// Awaitly: Built-in saga pattern with automatic compensation
import { createSagaWorkflow, isSagaCompensationError } from 'awaitly/durable';

const processOrderSaga = createSagaWorkflow('processOrder', {
  processPayment,
  refundPayment,
  reserveInventory,
  unreserveInventory,
  scheduleShipping,
});

const result = await processOrderSaga.run(async ({ step, deps }) => {
  // Step 1: Process payment (with compensation)
  const payment = await step(
    'Process payment',
    () => deps.processPayment(order.payment),
    { compensate: (p) => deps.refundPayment(p.id) }, // Runs on rollback
  );

  // Step 2: Reserve inventory (with compensation)
  await step(
    'Reserve inventory',
    () => deps.reserveInventory(order.items),
    { compensate: () => deps.unreserveInventory(order.items) },
  );

  // Step 3: Schedule shipping (no compensation needed)
  await step('Schedule shipping', () => deps.scheduleShipping(order));

  return { success: true, orderId: order.id };
});

// If step 3 fails, compensations run automatically in LIFO order:
// 1. unreserveInventory (step 2)
// 2. refundPayment (step 1)

if (!result.ok && isSagaCompensationError(result.error)) {
  console.log('Original error:', result.error.originalError);
  console.log('Compensation failures:', result.error.compensationErrors);
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

### Rate Limiting Patterns

When calling rate-limited APIs or protecting shared resources:

```typescript
// try/catch: Manual token bucket
class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private maxPerSecond: number) {
    this.tokens = maxPerSecond;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens <= 0) {
      const waitTime = 1000 / this.maxPerSecond;
      await new Promise((r) => setTimeout(r, waitTime));
      return this.acquire();
    }
    this.tokens--;
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.maxPerSecond,
      this.tokens + (elapsed / 1000) * this.maxPerSecond
    );
    this.lastRefill = now;
  }
}

// Awaitly: Built-in rate limiting with multiple strategies
import {
  createRateLimiter,
  createConcurrencyLimiter,
  createCombinedLimiter,
} from 'awaitly';

// Rate limiting: requests per second
const apiLimiter = createRateLimiter('stripe-api', {
  maxPerSecond: 10,
  burstCapacity: 20,
  strategy: 'wait', // Queue requests when limit hit
});

// Concurrency limiting: max parallel
const dbLimiter = createConcurrencyLimiter('db-pool', {
  maxConcurrent: 5,
  strategy: 'queue',
  maxQueueSize: 100,
});

// Combined for both
const limiter = createCombinedLimiter('api', {
  rate: { maxPerSecond: 10 },
  concurrency: { maxConcurrent: 5 },
});

// Usage
const result = await workflow.run(async ({ step, deps }) => {
  // Rate-limited call
  const data = await apiLimiter.execute(() =>
    step('callApi', () => deps.callApi())
  );

  // Batch with concurrency control
  const items = await dbLimiter.executeAll(
    ids.map((id) => () => step('fetchItem', () => deps.fetchItem(id)))
  );

  return { data, items };
});
```

**Why rate limiting matters:**

External APIs have rate limits. Database connections are finite. Without explicit control, you hit those limits during traffic spikes, when you need reliability most.

## Production Battle Stories

### Story 1: The Payment Processor That Learned to Fail Well

**The Problem**

A payment processor was using try/catch everywhere. When their primary payment provider had an outage, the entire service went down because exceptions were bubbling up and crashing request handlers.

**The Solution**

They migrated their core payment logic to neverthrow, allowing them to:

- Implement fallback payment providers
- Degrade to "payment pending" mode
- Log detailed error information without crashing

**The Result**

99.9% uptime even when individual providers failed. Customer support calls dropped by 80% during provider outages.

### Story 2: The Microservice That Couldn't Scale

**The Problem**

A microservice was taking on more load, and its error handling sat in try/catch blocks scattered across the code. When they needed to add timeouts, retries, and circuit breakers, the code became unmaintainable.

**The Solution**

They evaluated Effect and Awaitly. Effect's learning curve was too steep for the team's timeline, so they chose Awaitly, which allowed them to:

- Add retry and timeout policies with `step.retry()` and `step.withTimeout()`
- Implement circuit breakers for external services
- Add observability via the `onEvent` hook without changing business logic

**The Result**

Reduced incident response time from hours to minutes. The team reported that debugging got easier because they could trace which step failed and why.

### Story 3: The Legacy Migration That Didn't Break Everything

**The Problem**

A large e-commerce platform wanted to improve error handling but couldn't afford to rewrite their entire system. They had millions of lines of code using try/catch.

**The Solution**

They used the boundary strategy:

- Kept try/catch at HTTP handlers and database layers
- Converted core business logic to neverthrow, one module at a time
- Used wrapper functions to bridge between paradigms

**The Result**

Improved error handling without any customer-facing downtime. The team took 6 months, one feature at a time.

### Story 4: The Workflow That Needed to Survive Crashes

**The Problem**

A long-running data processing pipeline crashed mid-execution every few weeks. When restarted, it would re-process everything from the beginning, causing duplicate charges and wasted compute.

**The Solution**

They adopted Awaitly with step caching and resume state:

- Each step was given a unique `key` for caching
- The `onEvent` hook persisted step results to a database
- On restart, the workflow resumed from the last successful step using `resumeState`

**The Result**

Zero duplicate processing. Crash recovery went from "restart everything" to "resume from last checkpoint" in under a minute.

### Story 5: The Approval Workflow That Needed to Pause

**The Problem**

A compliance team needed multi-level approval for high-value transactions: manager approval for orders over $10K, VP approval for orders over $100K. Their existing system used polling and manual status checks, leading to missed SLAs and audit gaps.

**The Solution**

They implemented Awaitly's Human-in-the-Loop orchestration:

```typescript
import { createHITLOrchestrator, createApprovalStep } from 'awaitly/durable';

const orchestrator = createHITLOrchestrator({
  approvalStore: redisApprovalStore,
  workflowStateStore: postgresStateStore,
  notificationChannel: {
    onApprovalNeeded: async (ctx) => {
      await slack.postMessage({
        channel: '#approvals',
        text: `Order ${ctx.metadata.orderId} needs ${ctx.reason}`,
        attachments: [{ actions: [approveButton, rejectButton] }],
      });
    },
  },
});

const processHighValueOrder = async (order) => {
  return orchestrator.execute('high-value-order', workflowFactory, async ({ step, deps, args: input }) => {
    const validated = await step('validateOrder', () => deps.validateOrder(input));

    if (validated.total > 100000) {
      await step('pendingApproval', () => pendingApproval('VP approval required'), {
        key: `vp-approval:${input.orderId}`,
      });
    } else if (validated.total > 10000) {
      await step('pendingApproval', () => pendingApproval('Manager approval required'), {
        key: `manager-approval:${input.orderId}`,
      });
    }

    await step('processPayment', () => deps.processPayment(validated));
    return { orderId: input.orderId, status: 'completed' };
  }, order);
};
```

**The Result**

- 99% SLA compliance (approvals completed within target time)
- Complete audit trail with timestamps, approvers, and decision history
- Slack integration meant approvers could approve from mobile
- Workflow state persisted across deployments and restarts

## The Final Word

Pick the approach that fits your context rather than the one that wins an argument. Weigh these:

**Team expertise**

How comfortable is your team with functional programming? If everyone knows JavaScript but nobody knows functional patterns, neverthrow will require training. Effect even more so. Awaitly sits in the middle: familiar async/await syntax with Result types.

**System complexity**

Count your failure modes. A CRUD app does fine on try/catch, and a distributed system earns back Effect's tooling. Awaitly suits the middle: systems that need retries, timeouts, and observability without full dependency injection.

**Performance requirements**

Are milliseconds critical, or is reliability more important? High-frequency trading systems care about nanoseconds. Most web apps care about correctness first.

**Migration constraints**

Are you working with legacy code or starting fresh? Greenfield projects have more flexibility. Legacy systems need gradual migration strategies.

**Feature requirements**

Do you need retries and timeouts? Awaitly and Effect have them built-in. neverthrow doesn't. Do you need workflow resume? Awaitly has it. Do you need dependency injection with layers? Effect has it.

Start simple and evolve as the code asks for it. The error handling strategy worth having is the one that lets you sleep at night.

When your pager goes off at 3 AM because payments are down, you'll thank yourself for thinking this through.

***

For more examples and working code, check out the [src/](./src/) directory.
