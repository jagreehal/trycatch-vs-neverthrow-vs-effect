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

Let's build a realistic payment processing system using all four approaches. This isn't toy code: it's the kind of system that handles real money and can't afford to lose a penny.

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

### Approach 3: The Orchestrator (Awaitly)

```typescript
import { ok, err, type AsyncResult } from 'awaitly';
import { createWorkflow } from 'awaitly/workflow';
import { retryPolicies } from 'awaitly/policies';

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

  return workflow(async ({ step, deps }) => {
    // 1) Validate input
    const input = await step('parse', () => deps.parse(raw), {
      name: 'Parse input',
      key: 'parse',
    });

    // 2) Check for existing payment (idempotency)
    const existing = await step('findExisting', () => deps.findExisting(db, input.idemKey), {
      name: 'Check existing',
      key: `existing:${input.idemKey}`,
    });

    if (existing) {
      return { paymentId: existing.id };
    }

    // 3) Acquire lock
    await step('acquireLock', () => deps.acquireLock(db, input.idemKey), {
      name: 'Acquire lock',
      key: `lock:${input.idemKey}`,
    });

    // 4) Call provider with retry and timeout
    let response: ProviderResponse;
    try {
      response = await step.retry(
        'callProvider',
        () => deps.callProvider(provider, input),
        {
          attempts: 3,
          backoff: 'exponential',
          initialDelay: 200,
          maxDelay: 3000,
          jitter: true,
          retryOn: (error) =>
            error instanceof ProviderSoftFail ||
            error instanceof TimeoutError,
          name: 'Call provider',
          key: `provider:${input.idemKey}`,
        }
      );
    } catch (e) {
      // Soft failures: persist failure record, then fail
      if (e instanceof ProviderSoftFail || e instanceof TimeoutError) {
        await step('persistFailure', () => deps.persistFailure(db, actorEmail, input, e), {
          name: 'Persist failure',
          key: `persist-fail:${input.idemKey}`,
        });
        throw new ProviderUnavailable(String(e));
      }
      throw e;
    }

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
```

**What makes this work well:**

**1. Familiar async/await syntax**

The code reads like standard JavaScript. No method chaining or generator syntax to learn. Junior developers can understand it immediately.

**2. Built-in retry and timeout**

`step.retry()` handles exponential backoff with jitter out of the box. No need to write custom retry logic or import additional libraries.

**3. Step caching with keys**

Each step has a `key` parameter. If the workflow is resumed (e.g., after a crash), completed steps are skipped. This is critical for payment processing where you don't want to charge twice.

**4. Automatic error inference**

The workflow automatically computes the union of all possible errors from your dependencies. TypeScript knows exactly what errors can occur without manual type annotations.

**5. Observability built-in**

Add `onEvent` to the workflow options and you get step-by-step events for logging, tracing, and debugging.

**6. Policy-driven configuration**

Apply pre-built policies for common patterns: `withPolicy(servicePolicies.httpApi)` gives you 5-second timeout with 3 retries. Build consistent reliability across your entire codebase.

**7. Production-grade reliability features**

Circuit breakers, rate limiting, saga compensation, durable execution, and human-in-the-loop orchestration are all built-in. No need to implement these patterns yourself.

### Awaitly Advanced Features

Beyond basic workflows, Awaitly provides a comprehensive suite of production-ready features.

#### Durable Execution

Persist workflow state automatically and resume from any point after crashes or deployments:

```typescript
import { durable } from 'awaitly/durable';

// Omit store to use default in-memory persistence (per process). Pass a SnapshotStore for cross-restart persistence.
const result = await durable.run(
  { chargeCard, sendReceipt, updateInventory },
  async ({ step, deps }) => {
    // Each keyed step is automatically checkpointed
    const charge = await step('chargeCard', () => deps.chargeCard(payment), {
      key: 'charge',
      name: 'Charge card',
    });

    await step('updateInventory', () => deps.updateInventory(items), {
      key: 'inventory',
      name: 'Update inventory',
    });

    await step('sendReceipt', () => deps.sendReceipt(charge), {
      key: 'receipt',
      name: 'Send receipt',
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

#### Saga Pattern (Automatic Compensation)

Define compensating actions for rollback when downstream steps fail:

```typescript
import { createSagaWorkflow, isSagaCompensationError } from 'awaitly/saga';

const checkout = createSagaWorkflow({
  reserveInventory,
  chargeCard,
  scheduleShipping,
});

const result = await checkout(async ({ saga, deps }) => {
  // Step 1: Reserve inventory (with compensation)
  const reservation = await saga.step(
    'Reserve inventory',
    () => deps.reserveInventory(items),
    { compensate: (res) => releaseInventory(res.reservationId) }
  );

  // Step 2: Charge card (with compensation)
  const payment = await saga.step(
    'Charge card',
    () => deps.chargeCard(amount),
    { compensate: (p) => refundPayment(p.transactionId) }
  );

  // Step 3: Schedule shipping (no compensation needed)
  await saga.step('Schedule shipping', () => deps.scheduleShipping(reservation.id));

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
- **LIFO compensation**: Compensations run in reverse order automatically
- **`saga.step`**: Execute Result-returning operations with optional compensation
- **`saga.tryStep`**: Execute throwing operations with error mapping
- **Compensation error tracking**: Know which compensations failed and why

#### Circuit Breaker

Prevent cascading failures with built-in circuit breaker:

```typescript
import {
  createCircuitBreaker,
  circuitBreakerPresets,
  isCircuitOpenError,
} from 'awaitly/circuit-breaker';

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
const result = await workflow(async ({ step, deps }) => {
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
- `critical`: Opens quickly (3 failures), recovers slowly (60s)
- `standard`: Balanced (5 failures, 30s reset)
- `lenient`: Opens slowly (10 failures), recovers quickly (15s)

#### Rate Limiting

Control throughput for rate-limited APIs or shared resources:

```typescript
import {
  createRateLimiter,
  createConcurrencyLimiter,
  createCombinedLimiter,
} from 'awaitly/ratelimit';

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
const result = await workflow(async ({ step, deps }) => {
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
} from 'awaitly/policies';

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
import { mergePolicies } from 'awaitly/policies';

const customPolicy = mergePolicies(
  timeoutPolicies.api, // 5s timeout
  retryPolicies.aggressive, // 5 attempts
  { name: 'critical-call' }
);
```

#### Singleflight (Request Coalescing)

Deduplicate concurrent identical requests:

```typescript
import { singleflight } from 'awaitly/singleflight';

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

#### Streaming with Results (v1.11.0)

The `awaitly/streaming` module provides Result-aware stream processing with transformers and backpressure handling:

```typescript
import {
  createMemoryStreamStore,
  createFileStreamStore,
  map,
  filter,
  flatMap,
  chunk,
  take,
  skip,
  collect,
  reduce,
} from 'awaitly/streaming';

// Create stream stores for workflow integration
const memoryStore = createMemoryStreamStore<string>();
const fileStore = createFileStreamStore('./output.txt');

await run(async ({ step }) => {
  // Get writable and readable streams within workflow
  const writable = await step.getWritable(memoryStore, { key: 'stream-output' });
  const readable = await step.getReadable(memoryStore, { key: 'stream-input' });

  // Transform pipeline with Result-aware operators
  const processed = readable
    .pipeThrough(map((line) => ok(line.toUpperCase())))
    .pipeThrough(filter((line) => line.startsWith('VALID:')))
    .pipeThrough(flatMap((line) => ok(line.split(',')))) // One-to-many
    .pipeThrough(chunk(100)) // Batch into arrays of 100
    .pipeThrough(take(1000)); // Limit total items

  // Collect all results
  const results = await step('collect', () => collect(processed));

  // Or reduce to a single value
  const count = await step('reduce', () => reduce(processed, (acc, item) => acc + 1, 0));

  return { results, count };
});
```

**Backpressure Handling:**

```typescript
import { createBackpressuredWriter } from 'awaitly/streaming';

const writer = createBackpressuredWriter(writable, {
  highWaterMark: 1000,
  onBackpressure: () => console.log('Slowing down...'),
  onDrain: () => console.log('Resuming...'),
});

// Automatically pauses when buffer is full
for (const item of hugeDataset) {
  await writer.write(item);
}
await writer.close();
```

**Limitations vs Effect Stream:**
- No windowing or complex time-based operations
- Less sophisticated backpressure strategies
- Simpler API trades off some power for familiarity

#### Functional Utilities (v1.11.0)

The `awaitly/functional` module provides Effect-style composition utilities:

```typescript
import { pipe, flow, compose, R } from 'awaitly/functional';

// pipe: Apply functions left-to-right to a value
const result = pipe(
  { name: 'Alice', age: 30 },
  R.map((user) => ({ ...user, name: user.name.toUpperCase() })),
  R.andThen((user) => validateUser(user)),
  R.mapError((e) => new ApiError(e))
);

// flow: Create reusable pipelines (functions, not values)
const processOrder = flow(
  validateOrder,
  R.andThen(calculateTotal),
  R.andThen(applyDiscount),
  R.mapError(toOrderError)
);

const result = await processOrder(orderData);

// compose: Like flow but right-to-left (traditional FP style)
const processOrder = compose(
  R.mapError(toOrderError),
  R.andThen(applyDiscount),
  R.andThen(calculateTotal),
  validateOrder
);
```

**R Namespace (Curried Pipeable Functions):**

```typescript
import { R } from 'awaitly/functional';

// R provides curried versions for use in pipe/flow
R.map((x) => x * 2)           // Result<A, E> => Result<B, E>
R.mapError((e) => new Error(e)) // Result<A, E1> => Result<A, E2>
R.andThen((x) => fetchData(x))  // Result<A, E1> => Result<B, E1 | E2>
R.orElse((e) => ok(defaultValue)) // Result<A, E> => Result<A, never>
R.unwrapOr(defaultValue)        // Result<A, E> => A
R.tap((x) => console.log(x))    // Side effect without changing value
R.tapError((e) => logError(e))  // Side effect on error
```

**Collection Utilities:**

```typescript
import { all, allAsync, allSettled, any, race, traverse } from 'awaitly/functional';

// all: Combine sync Results (first-error semantics)
const result = all([validateA(a), validateB(b), validateC(c)]);

// allAsync: Combine async Results
const result = await allAsync([fetchA(), fetchB(), fetchC()]);

// allSettled: Collect all errors
const result = allSettled([validateA(a), validateB(b), validateC(c)]);

// any: First success wins
const result = await any([tryCache(), tryDb(), tryApi()]);

// race: First to complete (success or error)
const result = await race([fastApi(), slowApi()]);

// traverse: Map then combine
const result = await traverse(userIds, (id) => fetchUser(id));
```

**Limitations vs Effect:**
- No Fiber semantics or structured concurrency
- No Effect's Layer/Context for dependency injection
- Designed as a stepping stone, not a replacement

#### Type-Safe Fetch (v1.11.0)

The `awaitly/fetch` module provides type-safe HTTP operations with built-in error types:

```typescript
import { fetchJson, fetchText, fetchBlob, fetchArrayBuffer } from 'awaitly/fetch';

// Basic usage with automatic error typing
const result = await fetchJson<User>('https://api.example.com/users/1');

if (!result.ok) {
  // Error types: NOT_FOUND | BAD_REQUEST | UNAUTHORIZED | FORBIDDEN | SERVER_ERROR | NETWORK_ERROR
  switch (result.error.type) {
    case 'NOT_FOUND':
      console.log('User not found');
      break;
    case 'UNAUTHORIZED':
      console.log('Please log in');
      break;
    case 'NETWORK_ERROR':
      console.log('Check your connection');
      break;
    case 'SERVER_ERROR':
      console.log(`Server error: ${result.error.status}`);
      break;
  }
}

// With request options
const result = await fetchJson<CreateUserResponse>('https://api.example.com/users', {
  method: 'POST',
  body: JSON.stringify({ name: 'Alice' }),
  headers: { 'Content-Type': 'application/json' },
});

// Other fetch helpers
const textResult = await fetchText('https://api.example.com/readme');
const blobResult = await fetchBlob('https://api.example.com/image.png');
const bufferResult = await fetchArrayBuffer('https://api.example.com/binary');
```

**Custom Error Mapping:**

```typescript
type MyError =
  | { type: 'USER_NOT_FOUND'; userId: string }
  | { type: 'VALIDATION_ERROR'; fields: string[] }
  | { type: 'API_ERROR'; status: number };

const result = await fetchJson<User, MyError>('https://api.example.com/users/1', {
  mapError: (status, body) => {
    if (status === 404) {
      return { type: 'USER_NOT_FOUND', userId: body?.userId ?? 'unknown' };
    }
    if (status === 400) {
      return { type: 'VALIDATION_ERROR', fields: body?.errors ?? [] };
    }
    return { type: 'API_ERROR', status };
  },
});
```

**In Workflows:**

```typescript
const workflow = createWorkflow('fetchUserPosts', {
  fetchUser: (id: string) => fetchJson<User>(`/api/users/${id}`),
  fetchPosts: (userId: string) => fetchJson<Post[]>(`/api/users/${userId}/posts`),
});

const result = await workflow(async ({ step, deps }) => {
  const user = await step('getUser', () => deps.fetchUser('1'));
  const posts = await step('getPosts', () => deps.fetchPosts(user.id));
  return { user, posts };
});
// Error type automatically includes: NOT_FOUND | BAD_REQUEST | ... | UnexpectedError
```

**Limitations vs Effect HttpClient:**
- Less configurability (interceptors, retry policies built into client)
- No request/response middleware pipeline
- Simpler API for common use cases

#### step.sleep() with Duration Support (v1.11.0)

Cancellation-aware delays with human-readable duration strings:

```typescript
import { run } from 'awaitly/run';
import { seconds, minutes, hours, days, ms } from 'awaitly/duration';

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
  await step.sleep('delay', ms(500));

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

#### ESLint Plugin (eslint-plugin-awaitly v0.5.0)

Catch common Awaitly mistakes at compile time:

```javascript
// eslint.config.mjs
import awaitlyPlugin from 'eslint-plugin-awaitly';

export default [
  {
    files: ['**/*.ts'],
    plugins: { awaitly: awaitlyPlugin },
    rules: {
      // Prevents step(fn()) - must be step(() => fn())
      'awaitly/no-immediate-execution': 'error',

      // Requires thunk when using key option (for caching)
      'awaitly/require-thunk-for-key': 'error',

      // Warns about dynamic cache keys that may cause issues
      'awaitly/stable-cache-keys': 'warn',

      // Ensures workflows are awaited (no floating promises)
      'awaitly/no-floating-workflow': 'error',

      // Ensures Results are handled (like neverthrow/must-use-result)
      'awaitly/no-floating-result': 'error',

      // Enforces .ok checks before accessing .value
      'awaitly/require-result-handling': 'warn',

      // Prevents options on executor instead of step
      'awaitly/no-options-on-executor': 'error',

      // Prevents ok(ok(...)) double wrapping
      'awaitly/no-double-wrap-result': 'error',
    },
  },
];
```

**Rule Details:**

| Rule | Description | Fixable |
|------|-------------|---------|
| `no-immediate-execution` | Prevents `step(fn())` which executes immediately, not lazily | No |
| `require-thunk-for-key` | Requires `step(() => fn(), { key })` when using cache key | No |
| `stable-cache-keys` | Warns about `key: \`user:${Math.random()}\`` patterns | No |
| `no-floating-workflow` | Ensures `createWorkflow(...)` is awaited | No |
| `no-floating-result` | Ensures `Result` values are checked or used | No |
| `require-result-handling` | Warns when accessing `.value` without `.ok` check | No |
| `no-options-on-executor` | Prevents `workflow(async ({ step }) => {}, { retry })` | Yes |
| `no-double-wrap-result` | Prevents `ok(ok(value))` or `err(err(e))` | Yes |

**Example Violations:**

```typescript
// ❌ no-immediate-execution
await step('getUser', fetchUser('1')); // Executes immediately!
// ✅ Fix
await step('getUser', () => fetchUser('1'));

// ❌ require-thunk-for-key
await step('getUser', deps.fetchUser('1'), { key: 'user' }); // Can't cache without thunk
// ✅ Fix
await step('getUser', () => deps.fetchUser('1'), { key: 'user' });

// ❌ no-floating-result
const result = await fetchUser('1');
console.log(result.value); // Might be undefined!
// ✅ Fix
const result = await fetchUser('1');
if (result.ok) {
  console.log(result.value);
}

// ❌ no-double-wrap-result
return ok(ok(value)); // Double wrapped!
// ✅ Fix
return ok(value);
```

**Limitations:**
- Plugin is newer, may have edge cases with complex type inference
- Some rules are heuristic-based and may have false positives
- Requires ESLint 9+ flat config

#### Human-in-the-Loop (HITL)

Pause workflows for human approval and resume after:

```typescript
import {
  createHITLOrchestrator,
  createMemoryApprovalStore,
  createMemoryWorkflowStateStore,
  createApprovalStep,
} from 'awaitly/hitl';

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
- **State persistence**: Workflow state saved automatically when paused
- **Notification channels**: Integrate with Slack, email, or custom UIs
- **Webhook handlers**: Built-in handlers for approval/rejection endpoints

### Approach 4: The Architect (Effect)

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

### Awaitly: The Conductor Model

Think of yourself as a conductor leading an orchestra. You don't play every instrument; you coordinate musicians (dependencies) through a performance (workflow).

- **The Score**: Your workflow function is the sheet music
- **The Musicians**: Dependencies are injected and called via `step()`
- **House Rules (Policies)**: Timeouts, retries, and rate limits are established before the performance
- **Skip Failing Sections (Circuit Breakers)**: If a section keeps failing, temporarily skip it
- **Control Section Tempo (Rate Limiting)**: Ensure sections don't play too fast for the venue
- **Pause for Conductor's Signal (HITL)**: Wait for approval before critical movements
- **Undo Movements (Saga Compensations)**: If the finale fails, undo earlier movements in reverse
- **Early Exit**: If any musician misses their cue (error), the performance stops
- **Caching**: You can mark certain passages to avoid repeating them
- **Resume**: If the concert is interrupted, you can restart from the last completed movement

```typescript
// The conductor coordinates the performance
workflow(async ({ step, deps }) => {
  const user = await step('fetchUser', () => deps.fetchUser(id));    // Violin section
  const posts = await step('fetchPosts', () => deps.fetchPosts(id));  // Brass section
  return { user, posts };                                // Final bow
});
```

**Why this model works:**

It combines the familiarity of async/await with the safety of Result types. You write code that looks like standard JavaScript, but errors are tracked, retries are built-in, and the workflow is resumable.

**The full orchestra:**

When you need production-grade reliability, the conductor has access to a full ensemble of tools:

```typescript
// The full orchestra
const saga = createSagaWorkflow(deps); // Automatic compensation
const breaker = createCircuitBreaker('api'); // Fail-fast protection
const limiter = createRateLimiter('api', { maxPerSecond: 10 }); // Tempo control

await saga(async ({ saga, deps }) => {
  // Rate-limited, circuit-protected, compensating steps
  const data = await limiter.execute(() =>
    breaker.executeResult(() =>
      saga.step('callApi', () => deps.callApi(), {
        compensate: (d) => deps.rollback(d.id),
      })
    )
  );
  return data;
});
```

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

### The Four-Phase Evolution

**Phase 1: Foundation (try/catch everywhere)**

Start here. Build basic functionality, ship features, identify pain points where errors are hard to handle. Keep it simple until simplicity becomes painful.

**When to move to Phase 2:**
- You're writing the same error handling patterns repeatedly
- You're forgetting to catch errors and finding out at runtime
- Your error handling code is as complex as your business logic
- You need to compose operations but try/catch makes it painful

**Phase 2: Core Domain (introduce Result types)**

Refactor your most complex business logic to use Result types (neverthrow or Awaitly). Keep try/catch at system boundaries (HTTP handlers, event listeners, etc.). Gradually expand the Result-based code.

**Choosing between neverthrow and Awaitly:**
- **neverthrow**: If your team likes functional chaining (`.andThen().map()`) and you don't need retry/timeout built-in
- **Awaitly**: If your team prefers async/await and you want retries, timeouts, caching, or workflow resume

**When to move to Phase 3:**
- You need consistent policies (timeouts, retries) across your app
- You're implementing the same infrastructure patterns repeatedly
- Testing requires complex mocking and setup
- Your team is comfortable with functional programming concepts

**Phase 3: Policies (consider Effect or Awaitly's advanced features)**

If you chose Awaitly, you may already have what you need (retries, timeouts, circuit breakers). If you need more sophisticated orchestration (layers, structured concurrency, tracing), consider Effect.

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

You get the benefits of Result types in new code without rewriting everything. You can migrate incrementally, testing each piece as you go.

#### 2. The Boundary Strategy

Keep try/catch at your system boundaries but use Result types internally:

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

    await workflow(async ({ step, deps }) => {
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
import { createSagaWorkflow, isSagaCompensationError } from 'awaitly/saga';

describe('saga compensation', () => {
  it('should run compensations in LIFO order on failure', async () => {
    const compensationOrder: string[] = [];

    const saga = createSagaWorkflow({
      step1: () => Promise.resolve(ok({ id: '1' })),
      step2: () => Promise.resolve(ok({ id: '2' })),
      step3: () => Promise.resolve(err(new Error('Step 3 failed'))),
    });

    const result = await saga(async (ctx, deps) => {
      await ctx.step(() => deps.step1(), {
        compensate: () => { compensationOrder.push('step1'); },
      });
      await ctx.step(() => deps.step2(), {
        compensate: () => { compensationOrder.push('step2'); },
      });
      await ctx.step(() => deps.step3()); // This fails
      return 'done';
    });

    expect(result.ok).toBe(false);
    // Compensations run in reverse order
    expect(compensationOrder).toEqual(['step2', 'step1']);
  });

  it('should track compensation failures', async () => {
    const saga = createSagaWorkflow({ step1: () => ok({}), step2: () => err(new Error('fail')) });

    const result = await saga(async (ctx, deps) => {
      await ctx.step(() => deps.step1(), {
        compensate: () => { throw new Error('Compensation failed'); },
      });
      await ctx.step(() => deps.step2());
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
import { createCircuitBreaker, isCircuitOpenError } from 'awaitly/circuit-breaker';

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
} from 'awaitly/hitl';

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

Create flaky dependencies and verify the workflow retries correctly.

**4. Resume state testing**

Verify that workflows can be interrupted and resumed without repeating steps.

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
| **Streaming** | `awaitly/streaming` with transformers | Effect Stream (more powerful) |
| **Functional Utils** | `awaitly/functional` (pipe/flow/R) | Built-in pipe/flow |
| **HTTP Client** | `awaitly/fetch` (fetchJson, etc.) | HttpClient (more configurable) |
| **Sleep/Duration** | `step.sleep('id', '5s')` | `Effect.sleep(Duration.seconds(5))` |
| **ESLint Plugin** | `eslint-plugin-awaitly` (8 rules) | `@effect/eslint-plugin` |
| **Dependency Injection** | Dependencies object to workflow | Layers and Context |
| **Structured Concurrency** | Via `step.parallel()` | Built-in with fibers |
| **Observability** | `onEvent` callback | Built-in tracing and metrics |
| **Bundle Size** | ~8-15KB (tree-shakeable) | ~50KB+ |

**When to choose Awaitly:**
- Team familiar with async/await, less with FP
- Need production reliability features out of the box
- Want saga pattern and HITL without custom code
- Bundle size matters but you need more than neverthrow

**When to choose Effect:**
- Team comfortable with functional programming
- Need sophisticated dependency injection with layers
- Want structured concurrency with fiber semantics
- Building complex domain models with type-safe errors

## Performance Considerations

### Bundle Size Impact

The first question everyone asks: how much does this cost?

- **try/catch**: Zero additional bundle size (native JavaScript)
- **neverthrow**: Small footprint (~3-5KB minified + gzipped), tree-shakeable
- **Awaitly**: Moderate footprint (~8-15KB depending on features used), tree-shakeable entry points
- **Effect**: Larger runtime system (~50KB+ minified + gzipped)

**When bundle size matters:**

If you're building for mobile, edge functions, or environments where every kilobyte counts, try/catch's zero overhead is compelling. neverthrow adds minimal cost. Awaitly adds more but includes retry/timeout/caching. Effect requires justification.

### Runtime Characteristics

**Exceptions are expensive**

When try/catch actually catches exceptions, it's much slower than normal execution. The exact performance depends on:

- How deep the call stack is
- Whether the exception is caught locally or bubbles up
- The JavaScript engine's optimization (V8, SpiderMonkey, etc.)

**The key point: exceptions are only expensive when thrown**

If your error rate is truly low (<0.1%), the performance impact is negligible. But if errors are common (validation failures, expected business logic paths), exceptions become costly.

**Result types have consistent performance**

Success and error paths perform similarly, making performance more predictable. Whether you return `ok(value)` or `err(error)`, the cost is roughly the same. This applies to both neverthrow and Awaitly.

**Awaitly has step overhead**

Each `step()` call adds a small overhead for caching checks, event emission, and error handling. This is usually negligible compared to actual I/O operations (database, network), but it's there.

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
- You need sophisticated features (layers, structured concurrency, tracing)

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
} from 'awaitly/circuit-breaker';

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

const result = await workflow(async ({ step, deps }) => {
  // executeResult returns a Result, integrates cleanly with workflows
  const data = await breaker.executeResult(() =>
    step('callExternalService', () => deps.callExternalService())
  );

  if (!data.ok && isCircuitOpenError(data.error)) {
    return err(new ServiceUnavailable(`Retry after ${data.error.retryAfterMs}ms`));
  }

  return data;
});

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

// Awaitly: Imperative fallbacks with logging
const getDataWithFallbackAwaitly = createWorkflow('getDataWithFallback', {
  primaryAPI,
  cache,
  backupAPI,
});

const result = await getDataWithFallbackAwaitly(async ({ step, deps }) => {
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

// Awaitly: Built-in saga pattern with automatic compensation
import { createSagaWorkflow, isSagaCompensationError } from 'awaitly/saga';

const processOrderSaga = createSagaWorkflow({
  processPayment,
  reserveInventory,
  scheduleShipping,
});

const result = await processOrderSaga(async ({ saga, deps }) => {
  // Step 1: Process payment (with compensation)
  const payment = await saga.step(
    'Process payment',
    () => deps.processPayment(order.payment),
    { compensate: (p) => refundPayment(p.id) } // Runs on rollback
  );

  // Step 2: Reserve inventory (with compensation)
  await saga.step(
    'Reserve inventory',
    () => deps.reserveInventory(order.items),
    { compensate: () => unreserveInventory(order.items) }
  );

  // Step 3: Schedule shipping (no compensation needed)
  await saga.step('Schedule shipping', () => deps.scheduleShipping(order));

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
} from 'awaitly/ratelimit';

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
const result = await workflow(async ({ step, deps }) => {
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

External APIs have rate limits. Database connections are finite. Without explicit control, you'll hit limits at the worst times, usually during traffic spikes when you need reliability most.

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

They evaluated Effect and Awaitly. Effect's learning curve was too steep for the team's timeline, so they chose Awaitly, which allowed them to:

- Add retry and timeout policies with `step.retry()` and `step.withTimeout()`
- Implement circuit breakers for external services
- Add observability via the `onEvent` hook without changing business logic

**The Result**

Reduced incident response time from hours to minutes. The team reported that debugging became significantly easier because they could trace exactly which step failed and why.

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

### Story 4: The Workflow That Needed to Survive Crashes

**The Problem**

A long-running data processing pipeline would occasionally crash mid-execution. When restarted, it would re-process everything from the beginning, causing duplicate charges and wasted compute.

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
import { createHITLOrchestrator, createApprovalStep } from 'awaitly/hitl';

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

Error handling isn't about choosing the "best" approach: it's about choosing the right tool for your specific context. Consider:

**Team expertise**

How comfortable is your team with functional programming? If everyone knows JavaScript but nobody knows functional patterns, neverthrow will require training. Effect even more so. Awaitly sits in the middle: familiar async/await syntax with Result types.

**System complexity**

How many failure modes do you need to handle? Simple CRUD apps might be fine with try/catch. Complex distributed systems benefit from Effect's sophisticated tooling. Awaitly is a good middle ground for systems that need retries, timeouts, and observability but not full dependency injection.

**Performance requirements**

Are milliseconds critical, or is reliability more important? High-frequency trading systems care about nanoseconds. Most web apps care about correctness first.

**Migration constraints**

Are you working with legacy code or starting fresh? Greenfield projects have more flexibility. Legacy systems need gradual migration strategies.

**Feature requirements**

Do you need retries and timeouts? Awaitly and Effect have them built-in. neverthrow doesn't. Do you need workflow resume? Awaitly has it. Do you need dependency injection with layers? Effect has it.

Start simple, evolve gradually, and always remember: the best error handling strategy is the one that helps you sleep better at night.

When your pager goes off at 3 AM because payments are down, you'll thank yourself for thinking this through.

***

For more examples and working code, check out the [src/](./src/) directory.
