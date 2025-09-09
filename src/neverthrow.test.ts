import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Result, ResultAsync, ok, err, okAsync, errAsync } from 'neverthrow';

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

// --- Helpers
const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  ResultAsync.fromPromise(
    new Promise<T>((resolve, reject) => {
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
    }),
    toError
  );

const mapHttpError = (status: number, body?: unknown): Error => {
  if (status === 429 || status >= 500)
    return new ProviderSoftFail(`Provider ${status}`);
  if (status >= 400)
    return new ProviderHardFail(`Provider ${status}: ${JSON.stringify(body)}`);
  return new Error('Unknown provider error');
};

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

// --- Use case
export function createPaymentNeverthrow(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
): ResultAsync<{ paymentId: string }, Error> {
  
  // Parse input - pure Result transformation
  const parseInput = (): Result<CreatePayment, ValidationError> =>
    Result.fromThrowable(CreatePayment.parse, (e) =>
      e instanceof z.ZodError ? new ValidationError(e.message) : new ValidationError(String(e))
    )(raw);

  // Check for existing payment - returns Result
  const checkExisting = (input: CreatePayment): ResultAsync<CreatePayment | { paymentId: string }, Error> =>
    ResultAsync.fromPromise(db.findPaymentByKey(input.idemKey), toError)
      .map(existing => 
        existing ? { paymentId: existing.id } : input
      );

  // Acquire lock - returns Result
  const acquireLock = (input: CreatePayment): ResultAsync<CreatePayment, IdempotencyConflict> =>
    ResultAsync.fromPromise(db.acquireLock(input.idemKey), toError)
      .andThen(locked =>
        locked ? okAsync(input) : errAsync(new IdempotencyConflict('Concurrent request'))
      );

  // Call provider with retry logic - returns Result
  const callProvider = (input: CreatePayment): ResultAsync<{ input: CreatePayment; resp: ProviderResponse }, Error> => {
    const makeCall = (): ResultAsync<ProviderResponse, Error> =>
      withTimeout(
        provider.createPayment({
          amountMinor: input.amountMinor,
          currency: input.currency,
          reference: input.reference,
        }),
        2000
      ).mapErr((e: Error) => {
        const status = (e as any)?.status;
        return typeof status === 'number'
          ? mapHttpError(status, (e as any)?.body)
          : e;
      });

    return retryResult(
      makeCall,
      (e) => e instanceof ProviderSoftFail || e instanceof TimeoutError,
      3
    ).map(resp => ({ input, resp }));
  };

  // Persist success - returns Result
  const persistSuccess = ({ input, resp }: { input: CreatePayment; resp: ProviderResponse }): ResultAsync<{ paymentId: string }, PersistError> =>
    ResultAsync.fromPromise(
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
        return { paymentId: resp.id };
      }),
      (e) => new PersistError(String(e))
    );

  // Persist failure and return error - follows neverthrow philosophy
  const persistFailureAndFail = (input: CreatePayment, error: Error): ResultAsync<never, ProviderUnavailable> =>
    ResultAsync.fromPromise(
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
      () => new ProviderUnavailable(`Failed to persist failure record: ${String(error)}`)
    ).andThen(() => errAsync(new ProviderUnavailable(String(error))));

  // Main pipeline - pure functional composition
  return parseInput()
    .asyncAndThen(input => checkExisting(input))
    .andThen(result => {
      // If we found an existing payment, return it immediately
      if ('paymentId' in result) {
        return okAsync(result);
      }
      
      // Otherwise, process the new payment
      const input = result;
      return acquireLock(input)
        .andThen(callProvider)
        .orElse((error) => {
          // Handle soft failures by persisting failure record
          if (error instanceof ProviderSoftFail || error instanceof TimeoutError) {
            return persistFailureAndFail(input, error);
          }
          // Hard failures bubble up immediately
          return errAsync(error);
        })
        .andThen(persistSuccess);
    });
}

const makeDb = (): Db => {
  const existing: { [k: string]: { id: string } } = {};
  return {
    findPaymentByKey: async (key) => existing[key],
    acquireLock: async () => true,
    transaction: async (fn) =>
      fn({
        insertPayment: async (p: any) => {
          existing[p.idemKey] = { id: p.providerPaymentId };
        },
        insertAudit: async () => {},
      } as any),
  };
};

const makeProvider = (): Provider => ({
  createPayment: async (input: {
    amountMinor: number;
    currency: Currency;
    reference: string;
  }) => {
    return { id: `prov_${input.reference}`, status: 'CONFIRMED' } as const;
  },
});

describe('neverthrow', () => {
  it('creates payment happy path', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const result = await createPaymentNeverthrow(
      db,
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
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.paymentId).toBe('prov_ref1');
    } else {
      throw new Error('Expected success result');
    }
  });

  it('fails validation on bad input', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const result = await createPaymentNeverthrow(
      db,
      provider,
      {
        clientId: '', // invalid
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: 'short',
      },
      'user@example.com'
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ValidationError);
    } else {
      throw new Error('Expected error result');
    }
  });

  it('conflicts when lock not acquired', async () => {
    const db: Db = {
      ...makeDb(),
      acquireLock: async () => false,
    } as Db;
    const provider = makeProvider();
    const result = await createPaymentNeverthrow(
      db,
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
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(IdempotencyConflict);
    } else {
      throw new Error('Expected error result');
    }
  });

  it('maps provider 4xx to ProviderHardFail (no retry)', async () => {
    const db = makeDb();
    const provider: Provider = {
      createPayment: async () => {
        const err: any = new Error('bad req');
        err.status = 400;
        err.body = { error: 'bad' };
        throw err;
      },
    };
    const result = await createPaymentNeverthrow(
      db,
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
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ProviderHardFail);
    } else {
      throw new Error('Expected error result');
    }
  });

  it('retries provider 5xx then fails as ProviderUnavailable', async () => {
    const db = makeDb();
    const provider: Provider = {
      createPayment: async () => {
        const err: any = new Error('server error');
        err.status = 500;
        throw err;
      },
    };
    const result = await createPaymentNeverthrow(
      db,
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
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ProviderUnavailable);
    } else {
      throw new Error('Expected error result');
    }
  });

  it('idempotency fast path returns existing and skips provider', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const spy = vi.spyOn(provider, 'createPayment');
    // seed existing
    await db.transaction(async (tx: any) => {
      await tx.insertPayment({
        clientId: 'c1',
        amountMinor: 100,
        currency: 'GBP',
        providerPaymentId: 'prov_existing',
        status: 'CONFIRMED',
        idemKey: 'same-key-1234567890',
      });
    });
    const result = await createPaymentNeverthrow(
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
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.paymentId).toBe('prov_existing');
    } else {
      throw new Error('Expected success result');
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
