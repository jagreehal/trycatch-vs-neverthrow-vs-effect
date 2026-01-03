/**
 * Workflow Implementation - Payment Processing
 *
 * This demonstrates @jagreehal/workflow's key advantages:
 * 1. Automatic error type inference from dependencies
 * 2. Clean async/await syntax with step()
 * 3. Built-in retry, timeout, and caching
 * 4. Event stream for observability
 *
 * Compare with neverthrow.test.ts to see the difference in ergonomics.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  createWorkflow,
  ok,
  err,
  type AsyncResult,
  isStepComplete,
  type ResumeStateEntry,
} from '@jagreehal/workflow';

// ─────────────────────────────────────────────────────────────────────────────
// Types & Errors (shared across all implementations)
// ─────────────────────────────────────────────────────────────────────────────
export type Currency = 'GBP' | 'EUR' | 'USD';
export type ProviderResponse = {
  id: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
};

// Error types as string literals for automatic union inference
// (workflow infers these from AsyncResult return types)
type ValidationError = 'VALIDATION_ERROR';
type IdempotencyConflict = 'IDEMPOTENCY_CONFLICT';
type ProviderUnavailable = 'PROVIDER_UNAVAILABLE';
type ProviderHardFail = 'PROVIDER_HARD_FAIL';
type PersistError = 'PERSIST_ERROR';

export interface Db {
  findPaymentByKey(idemKey: string): PromiseLike<{ id: string } | undefined>;
  acquireLock(idemKey: string): PromiseLike<boolean>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface Tx {
  insertPayment(p: {
    clientId: string;
    amountMinor: number;
    currency: Currency;
    providerPaymentId: string;
    status: 'PENDING' | 'CONFIRMED' | 'FAILED';
    idemKey: string;
  }): Promise<void>;
  insertAudit(e: {
    actor: string;
    action: string;
    metadata: unknown;
  }): Promise<void>;
}

export interface Provider {
  createPayment(input: {
    amountMinor: number;
    currency: Currency;
    reference: string;
  }): Promise<ProviderResponse>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────
const CreatePaymentSchema = z.object({
  clientId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR', 'USD']),
  reference: z.string().min(1),
  idemKey: z.string().min(16),
});
type CreatePayment = z.infer<typeof CreatePaymentSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (each returns AsyncResult<T, E>)
// TypeScript automatically infers the error union from these
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate input using Zod schema
 * @returns AsyncResult<CreatePayment, 'VALIDATION_ERROR'>
 */
const validateInput = (raw: unknown): AsyncResult<CreatePayment, ValidationError> =>
  Promise.resolve(
    CreatePaymentSchema.safeParse(raw).success
      ? ok(CreatePaymentSchema.parse(raw))
      : err('VALIDATION_ERROR')
  );

/**
 * Check for existing payment (idempotency fast path)
 * @returns AsyncResult<{ id: string } | undefined, never>
 */
const findExisting = (
  db: Db,
  idemKey: string
): AsyncResult<{ id: string } | undefined, never> =>
  Promise.resolve(db.findPaymentByKey(idemKey)).then((existing) => ok(existing));

/**
 * Acquire lock for idempotent processing
 * @returns AsyncResult<void, 'IDEMPOTENCY_CONFLICT'>
 */
const acquireLock = (
  db: Db,
  idemKey: string
): AsyncResult<void, IdempotencyConflict> =>
  Promise.resolve(db.acquireLock(idemKey)).then((locked) =>
    locked ? ok(undefined) : err('IDEMPOTENCY_CONFLICT')
  );

/**
 * Call payment provider with retry and timeout
 * @returns AsyncResult<ProviderResponse, 'PROVIDER_HARD_FAIL' | 'PROVIDER_UNAVAILABLE'>
 */
const callProvider = async (
  provider: Provider,
  input: CreatePayment,
  options?: { timeoutMs?: number; maxAttempts?: number }
): AsyncResult<ProviderResponse, ProviderHardFail | ProviderUnavailable> => {
  const timeoutMs = options?.timeoutMs ?? 2000;
  const maxAttempts = options?.maxAttempts ?? 3;

  const tryCall = async (): Promise<ProviderResponse> => {
    return new Promise<ProviderResponse>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
        timeoutMs
      );

      provider
        .createPayment({
          amountMinor: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
        })
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  };

  // Retry with exponential backoff
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await tryCall();
      return ok(response);
    } catch (e: unknown) {
      lastError = e;

      // Check if error is retriable
      const status = (e as { status?: number })?.status;
      if (typeof status === 'number') {
        // 4xx errors are not retriable
        if (status >= 400 && status < 500) {
          return err('PROVIDER_HARD_FAIL');
        }
      }

      // Retry on 5xx, timeout, or unknown errors
      if (attempt < maxAttempts) {
        const delay = Math.min(100 * 2 ** attempt, 3000) + Math.random() * 100;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted
  return err('PROVIDER_UNAVAILABLE');
};

/**
 * Persist successful payment
 * @returns AsyncResult<{ paymentId: string }, 'PERSIST_ERROR'>
 */
const persistSuccess = async (
  db: Db,
  input: CreatePayment,
  response: ProviderResponse,
  actorEmail: string
): AsyncResult<{ paymentId: string }, PersistError> => {
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
    return ok({ paymentId: response.id });
  } catch {
    return err('PERSIST_ERROR');
  }
};

/**
 * Persist failed payment (for audit/debugging)
 */
const persistFailure = async (
  db: Db,
  input: CreatePayment,
  reason: string,
  actorEmail: string
): Promise<void> => {
  try {
    await db.transaction(async (tx) => {
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
        metadata: { reason },
      });
    });
  } catch {
    // Swallow persist errors for failure records
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Create workflow with automatic error inference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The workflow infers the error union automatically from the dependencies.
 *
 * TypeScript knows the result type is:
 * AsyncResult<{ paymentId: string }, ValidationError | IdempotencyConflict |
 *   ProviderHardFail | ProviderUnavailable | PersistError | UnexpectedError>
 *
 * Compare to neverthrow where you must manually declare this union!
 */
const createPaymentDeps = {
  validateInput,
  findExisting: (db: Db, idemKey: string) => findExisting(db, idemKey),
  acquireLock: (db: Db, idemKey: string) => acquireLock(db, idemKey),
  callProvider: (provider: Provider, input: CreatePayment) =>
    callProvider(provider, input),
  persistSuccess: (
    db: Db,
    input: CreatePayment,
    response: ProviderResponse,
    actorEmail: string
  ) => persistSuccess(db, input, response, actorEmail),
};

export function createPaymentWorkflow(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
) {
  // Create workflow with event stream for observability
  const savedSteps = new Map<string, ResumeStateEntry>();

  const workflow = createWorkflow(createPaymentDeps, {
    onEvent: (event) => {
      // Capture completed steps for potential resume
      if (isStepComplete(event)) {
        savedSteps.set(event.stepKey, { result: event.result, meta: event.meta });
      }
    },
  });

  // Execute workflow with clean async/await syntax
  return workflow(async (step, deps) => {
    // 1) Validate input
    const input = await step(() => deps.validateInput(raw), {
      name: 'Validate input',
      key: 'validate',
    });

    // 2) Check for existing payment (idempotency fast path)
    const existing = await step(() => deps.findExisting(db, input.idemKey), {
      name: 'Check existing',
      key: `existing:${input.idemKey}`,
    });

    if (existing) {
      return { paymentId: existing.id };
    }

    // 3) Acquire lock
    await step(() => deps.acquireLock(db, input.idemKey), {
      name: 'Acquire lock',
      key: `lock:${input.idemKey}`,
    });

    // 4) Call provider
    const providerResult = await deps.callProvider(provider, input);

    if (!providerResult.ok) {
      // Persist failure for audit trail
      await persistFailure(db, input, providerResult.error, actorEmail);
      return await step(providerResult); // This will early-exit with the error
    }

    // 5) Persist success
    return await step(
      () => deps.persistSuccess(db, input, providerResult.value, actorEmail),
      {
        name: 'Persist success',
        key: `persist:${input.idemKey}`,
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────
const makeDb = (): Db => {
  const existing: { [k: string]: { id: string } } = {};
  return {
    findPaymentByKey: async (key) => existing[key],
    acquireLock: async () => true,
    transaction: async (fn) =>
      fn({
        insertPayment: async (p) => {
          existing[p.idemKey] = { id: p.providerPaymentId };
        },
        insertAudit: async () => {},
      } as Tx),
  };
};

const makeProvider = (): Provider => ({
  createPayment: async (input) => ({
    id: `prov_${input.reference}`,
    status: 'CONFIRMED',
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
describe('workflow', () => {
  it('creates payment happy path', async () => {
    const result = await createPaymentWorkflow(
      makeDb(),
      makeProvider(),
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.paymentId).toBe('prov_ref1');
  });

  it('fails validation on bad input', async () => {
    const result = await createPaymentWorkflow(
      makeDb(),
      makeProvider(),
      {
        clientId: '', // invalid
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: 'short', // invalid
      },
      'user@example.com'
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('VALIDATION_ERROR');
  });

  it('conflicts when lock not acquired', async () => {
    const db = { ...makeDb(), acquireLock: async () => false };

    const result = await createPaymentWorkflow(
      db,
      makeProvider(),
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('maps provider 4xx to PROVIDER_HARD_FAIL (no retry)', async () => {
    const provider: Provider = {
      createPayment: async () => {
        const error = new Error('bad request') as Error & { status: number };
        error.status = 400;
        throw error;
      },
    };

    const result = await createPaymentWorkflow(
      makeDb(),
      provider,
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('PROVIDER_HARD_FAIL');
  });

  it('retries provider 5xx then fails as PROVIDER_UNAVAILABLE', async () => {
    const provider: Provider = {
      createPayment: async () => {
        const error = new Error('server error') as Error & { status: number };
        error.status = 500;
        throw error;
      },
    };

    const result = await createPaymentWorkflow(
      makeDb(),
      provider,
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBe('PROVIDER_UNAVAILABLE');
  });

  it('idempotency fast path returns existing and skips provider', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const spy = vi.spyOn(provider, 'createPayment');

    // Seed existing payment
    await db.transaction(async (tx) => {
      await tx.insertPayment({
        clientId: 'c1',
        amountMinor: 100,
        currency: 'GBP',
        providerPaymentId: 'prov_existing',
        status: 'CONFIRMED',
        idemKey: 'same-key-1234567890',
      });
    });

    const result = await createPaymentWorkflow(
      db,
      provider,
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: 'same-key-1234567890',
      },
      'user@example.com'
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.paymentId).toBe('prov_existing');
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional workflow-specific tests
// ─────────────────────────────────────────────────────────────────────────────
describe('workflow: additional features', () => {
  it('captures events for observability', async () => {
    const events: string[] = [];

    const deps = {
      fetchData: (): AsyncResult<string, 'FETCH_ERROR'> =>
        Promise.resolve(ok('data')),
    };

    const workflow = createWorkflow(deps, {
      onEvent: (event) => events.push(event.type),
    });

    await workflow(async (step, d) => {
      return await step(() => d.fetchData(), { name: 'Fetch data', key: 'fetch' });
    });

    expect(events).toContain('workflow_start');
    expect(events).toContain('step_start');
    expect(events).toContain('step_success');
    expect(events).toContain('step_complete');
    expect(events).toContain('workflow_success');
  });

  it('supports step caching for repeated calls', async () => {
    let callCount = 0;

    const deps = {
      expensiveOp: (): AsyncResult<number, never> => {
        callCount++;
        return Promise.resolve(ok(42));
      },
    };

    const cache = new Map();
    const workflow = createWorkflow(deps, { cache });

    await workflow(async (step, d) => {
      const a = await step(() => d.expensiveOp(), { key: 'expensive' });
      const b = await step(() => d.expensiveOp(), { key: 'expensive' }); // Cached!
      return a + b;
    });

    expect(callCount).toBe(1); // Only called once
  });

  it('demonstrates automatic error union inference', async () => {
    // These deps have different error types
    const deps = {
      validateUser: (id: string): AsyncResult<{ id: string }, 'USER_NOT_FOUND'> =>
        id === '1' ? Promise.resolve(ok({ id })) : Promise.resolve(err('USER_NOT_FOUND')),

      checkPermission: (userId: string): AsyncResult<void, 'PERMISSION_DENIED'> =>
        userId === '1' ? Promise.resolve(ok(undefined)) : Promise.resolve(err('PERMISSION_DENIED')),

      saveData: (_data: string): AsyncResult<void, 'SAVE_ERROR'> =>
        Promise.resolve(ok(undefined)),
    };

    // TypeScript automatically infers error union:
    // 'USER_NOT_FOUND' | 'PERMISSION_DENIED' | 'SAVE_ERROR' | UnexpectedError
    const workflow = createWorkflow(deps);

    const result = await workflow(async (step, d) => {
      const user = await step(d.validateUser('1'));
      await step(d.checkPermission(user.id));
      await step(d.saveData('test'));
      return 'success';
    });

    expect(result.ok).toBe(true);

    // Test error case - TypeScript knows exact error type
    const errorResult = await workflow(async (step, d) => {
      await step(d.validateUser('999')); // Will fail
      return 'never reached';
    });

    expect(errorResult.ok).toBe(false);
    if (!errorResult.ok) {
      // TypeScript knows this is one of the declared error types
      expect(errorResult.error).toBe('USER_NOT_FOUND');
    }
  });
});
