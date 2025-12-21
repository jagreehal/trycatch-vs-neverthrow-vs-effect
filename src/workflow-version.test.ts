import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { run, ok, err, type AsyncResult } from '@jagreehal/workflow';

// --- Types / errors
export type Currency = 'GBP' | 'EUR' | 'USD';
export type ProviderResponse = {
  id: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
};

export class ValidationError extends Error {}
export class IdempotencyConflict extends Error {}
export class ProviderUnavailable extends Error {}
export class ProviderSoftFail extends Error {}
export class ProviderHardFail extends Error {}
export class PersistError extends Error {}
export class TimeoutError extends Error {}

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

// --- Schema
const CreatePayment = z.object({
  clientId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR', 'USD']),
  reference: z.string().min(1),
  idemKey: z.string().min(16),
});
type CreatePayment = z.infer<typeof CreatePayment>;

// --- Types for HTTP errors
class HttpError extends Error {
  status: number;
  body?: unknown;
  
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = 'HttpError';
  }
}

// --- Helpers
const mapHttpError = (status: number, body?: unknown): Error => {
  if (status === 429 || status >= 500)
    return new ProviderSoftFail(`Provider ${status}`);
  if (status >= 400)
    return new ProviderHardFail(`Provider ${status}: ${JSON.stringify(body)}`);
  return new Error('Unknown provider error');
};

const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  attempts: number,
  baseMs: number
): Promise<T> => {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ProviderSoftFail || e instanceof TimeoutError)) {
        // Ensure we throw an Error instance
        const error = e instanceof Error ? e : new Error(String(e));
        throw error;
      }
      const backoff =
        Math.min(baseMs * 2 ** i, 3000) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  // Ensure we throw an Error instance
  const error = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  throw error;
};

// --- Simple step functions (return AsyncResult)
const parseInput = (raw: unknown): AsyncResult<CreatePayment, ValidationError> =>
  Promise.resolve(
    CreatePayment.safeParse(raw).success
      ? ok(CreatePayment.parse(raw))
      : err(new ValidationError(CreatePayment.safeParse(raw).error!.message))
  );

const findExisting = (
  db: Db,
  idemKey: string
): AsyncResult<{ id: string } | undefined, never> =>
  Promise.resolve(db.findPaymentByKey(idemKey)).then((existing) => ok(existing));

const acquireLock = (
  db: Db,
  idemKey: string
): AsyncResult<void, IdempotencyConflict> =>
  Promise.resolve(db.acquireLock(idemKey)).then((locked) =>
    locked ? ok(undefined) : err(new IdempotencyConflict('Concurrent request'))
  );

const callProvider = async (
  provider: Provider,
  input: CreatePayment
): AsyncResult<ProviderResponse, ProviderHardFail | ProviderUnavailable> => {
  try {
    const response = await retryWithBackoff(
      async () => {
        const timeoutPromise = new Promise<ProviderResponse>((resolve, reject) => {
          const t = setTimeout(
            () => reject(new TimeoutError(`Timed out after 2000ms`)),
            2000
          );
          provider
            .createPayment({
              amountMinor: input.amountMinor,
              currency: input.currency,
              reference: input.reference,
            })
            .then(
              (v) => { clearTimeout(t); resolve(v); },
              (e) => { clearTimeout(t); reject(e); }
            );
        });
        try {
          return await timeoutPromise;
        } catch (e: unknown) {
          if (e && typeof e === 'object' && 'status' in e) {
            const httpError = e as HttpError;
            throw mapHttpError(httpError.status, httpError.body);
          }
          // Ensure we throw an Error instance
          const error = e instanceof Error ? e : new Error(String(e));
          throw error;
        }
      },
      3,
      200
    );
    return ok(response);
  } catch (e) {
    if (e instanceof ProviderSoftFail || e instanceof TimeoutError) {
      return err(new ProviderUnavailable(String(e)));
    }
    if (e instanceof ProviderHardFail) return err(e);
    return err(new ProviderUnavailable(String(e)));
  }
};

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
  } catch (e) {
    return err(new PersistError(String(e)));
  }
};

const persistFailure = async (
  db: Db,
  input: CreatePayment,
  error: Error,
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
        metadata: { reason: String(error) },
      });
    });
  } catch {
    // Swallow persist errors for failure records
  }
};

// --- Use case: Clean imperative workflow with run()
type WorkflowError =
  | ValidationError
  | IdempotencyConflict
  | ProviderUnavailable
  | ProviderHardFail
  | PersistError;

export function createPaymentWorkflow(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
): AsyncResult<{ paymentId: string }, WorkflowError | import('@jagreehal/workflow').UnexpectedError> {
  return run(async (step) => {
    // 1) Validate input - step() unwraps Result, early-exits on error
    const input = await step(parseInput(raw));

    // 2) Idempotency check (fast path)
    const existing = await step(findExisting(db, input.idemKey));
    if (existing) return { paymentId: existing.id };

    // 3) Acquire lock
    await step(acquireLock(db, input.idemKey));

    // 4) Call provider - use step.try for operations that might throw
    const response = await step.try(
      () => callProvider(provider, input).then((r) => {
        if (!r.ok) {
          // Ensure we throw an Error instance (both error types extend Error)
          const error = r.error instanceof Error ? r.error : new Error(String(r.error));
          throw error;
        }
        return r.value;
      }),
      {
        onError: (e) => {
          // Persist failure record for soft failures
          if (e instanceof ProviderUnavailable) {
            void persistFailure(db, input, e, actorEmail);
          }
          return e as ProviderHardFail | ProviderUnavailable;
        },
      }
    );

    // 5) Persist success
    return await step(persistSuccess(db, input, response, actorEmail));
  }, {
    onError: () => {}, // errors captured in Result
  });
}

// --- Test fixtures
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

// --- Tests
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
      { clientId: '', amountMinor: 123, currency: 'GBP', reference: 'ref1', idemKey: 'short' },
      'user@example.com'
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(ValidationError);
  });

  it('conflicts when lock not acquired', async () => {
    const db = { ...makeDb(), acquireLock: async () => false };
    const result = await createPaymentWorkflow(
      db,
      makeProvider(),
      { clientId: 'c1', amountMinor: 123, currency: 'GBP', reference: 'ref1', idemKey: '1234567890abcdef' },
      'user@example.com'
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(IdempotencyConflict);
  });

  it('maps provider 4xx to ProviderHardFail (no retry)', async () => {
    const provider: Provider = {
      createPayment: async () => {
        throw new HttpError('bad req', 400, { error: 'bad' });
      },
    };
    const result = await createPaymentWorkflow(
      makeDb(),
      provider,
      { clientId: 'c1', amountMinor: 123, currency: 'GBP', reference: 'ref1', idemKey: '1234567890abcdef' },
      'user@example.com'
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(ProviderHardFail);
  });

  it('retries provider 5xx then fails as ProviderUnavailable', async () => {
    const provider: Provider = {
      createPayment: async () => {
        throw new HttpError('server error', 500);
      },
    };
    const result = await createPaymentWorkflow(
      makeDb(),
      provider,
      { clientId: 'c1', amountMinor: 123, currency: 'GBP', reference: 'ref1', idemKey: '1234567890abcdef' },
      'user@example.com'
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(ProviderUnavailable);
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
      { clientId: 'c1', amountMinor: 123, currency: 'GBP', reference: 'ref1', idemKey: 'same-key-1234567890' },
      'user@example.com'
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.paymentId).toBe('prov_existing');
    expect(spy).not.toHaveBeenCalled();
  });
});
