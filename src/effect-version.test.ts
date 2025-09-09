import { describe, it, expect, vi } from 'vitest';

import { Effect, Layer, Context, Schedule, Duration } from 'effect';
import { z } from 'zod';

// --- Types / errors
export type Currency = 'GBP' | 'EUR' | 'USD';
export type ProviderResponse = {
  id: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
};

export class ValidationError extends Error {
  readonly _tag = 'ValidationError';
}
export class IdempotencyConflict extends Error {
  readonly _tag = 'IdempotencyConflict';
}
export class ProviderUnavailable extends Error {
  readonly _tag = 'ProviderUnavailable';
}
export class ProviderSoftFail extends Error {
  readonly _tag = 'ProviderSoftFail';
}
export class ProviderHardFail extends Error {
  readonly _tag = 'ProviderHardFail';
}
export class PersistError extends Error {
  readonly _tag = 'PersistError';
}
export class TimeoutError extends Error {
  readonly _tag = 'TimeoutError';
}

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

// Service tags (DI via Layer)
export const DbService = Context.GenericTag<Db>('DbService');
export const ProviderService = Context.GenericTag<Provider>('ProviderService');

// Schema (using zod here for brevity)
const CreatePayment = z.object({
  clientId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR', 'USD']),
  reference: z.string().min(1),
  idemKey: z.string().min(16),
});
type CreatePayment = z.infer<typeof CreatePayment>;

const mapHttpError = (status: number, body?: unknown): Error => {
  if (status === 429 || status >= 500)
    return new ProviderSoftFail(`Provider ${status}`);
  if (status >= 400)
    return new ProviderHardFail(`Provider ${status}: ${JSON.stringify(body)}`);
  return new Error('Unknown provider error');
};


// Exponential backoff + jitter, capped (retry max 3 attempts total)
const retrySchedule = Schedule.exponential(Duration.millis(200)).pipe(
  Schedule.jittered,
  Schedule.upTo(Duration.seconds(3)),
  Schedule.intersect(Schedule.recurs(2))
);

// --- Use case
// Pure functions that return Effects - composable building blocks
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
          currency: input.currency as Currency,
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
        duration: 2000,
        onTimeout: () => new TimeoutError(`Timed out after 2000ms`),
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

const persistSuccess = (input: CreatePayment, response: ProviderResponse, actorEmail: string) =>
  Effect.gen(function* () {
    const db = yield* DbService;
    
    return yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.insertPayment({
            clientId: input.clientId,
            amountMinor: input.amountMinor,
            currency: input.currency as Currency,
            providerPaymentId: response.id,
            status: response.status,
            idemKey: input.idemKey,
          });
          await tx.insertAudit({
            actor: actorEmail,
            action: 'PAYMENT_CREATED',
            metadata: { providerId: response.id },
          });
          return { paymentId: response.id };
        }),
      catch: (e) => new PersistError(String(e)),
    });
  });

const persistFailure = (input: CreatePayment, error: Error, actorEmail: string) =>
  Effect.gen(function* () {
    const db = yield* DbService;
    
    // First persist the failure record
    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.insertPayment({
            clientId: input.clientId,
            amountMinor: input.amountMinor,
            currency: input.currency as Currency,
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
      catch: (e) => new ProviderUnavailable(String(e)),
    });
    
    // Then fail with ProviderUnavailable
    return yield* Effect.fail(new ProviderUnavailable(String(error)));
  });

// Main Effect program - pure composition
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
        if (error instanceof TimeoutError || error instanceof ProviderSoftFail) {
          return persistFailure(lockedInput, error, actorEmail);
        }
        return Effect.fail(error); // Let other errors bubble up
      })
    );
    
    // Persist success
    return yield* persistSuccess(lockedInput, response, actorEmail);
  });

// Example composition at the edge:
export const makeDbLayer = (db: Db) =>
  Layer.effect(DbService, Effect.succeed(db));
export const makeProviderLayer = (p: Provider) =>
  Layer.effect(ProviderService, Effect.succeed(p));
export const makeAppLayer = (db: Db, p: Provider) =>
  makeDbLayer(db).pipe(Layer.merge(makeProviderLayer(p)));

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

describe('effect', () => {
  it('creates payment happy path', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const eff = createPaymentEffect(
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );
    const out = await Effect.runPromise(
      Effect.provide(eff, makeAppLayer(db, provider))
    );
    expect(out.paymentId).toBe('prov_ref1');
  });

  it('fails validation on bad input', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const eff = createPaymentEffect(
      {
        clientId: '', // invalid
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: 'short',
      },
      'user@example.com'
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(eff, makeAppLayer(db, provider))
    );
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(exit.cause._tag).toBe('Fail');
      if (exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBeInstanceOf(ValidationError);
      }
    }
  });

  it('conflicts when lock not acquired', async () => {
    const db = { ...makeDb(), acquireLock: async () => false } as Db;
    const provider = makeProvider();
    const eff = createPaymentEffect(
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(eff, makeAppLayer(db, provider))
    );
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(exit.cause._tag).toBe('Fail');
      if (exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBeInstanceOf(IdempotencyConflict);
      }
    }
  });

  it('maps provider 4xx to failure (no retry)', async () => {
    const db = makeDb();
    const provider: Provider = {
      createPayment: async () => {
        const err: any = new Error('bad req');
        err.status = 400;
        err.body = { error: 'bad' };
        throw err;
      },
    };
    const eff = createPaymentEffect(
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(eff, makeAppLayer(db, provider))
    );
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(exit.cause._tag).toBe('Fail');
      if (exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBeInstanceOf(ProviderHardFail);
      }
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
    const eff = createPaymentEffect(
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: '1234567890abcdef',
      },
      'user@example.com'
    );
    const exit = await Effect.runPromiseExit(
      Effect.provide(eff, makeAppLayer(db, provider))
    );
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure') {
      expect(exit.cause._tag).toBe('Fail');
      if (exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBeInstanceOf(ProviderUnavailable);
      }
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
    const eff = createPaymentEffect(
      {
        clientId: 'c1',
        amountMinor: 123,
        currency: 'GBP',
        reference: 'ref1',
        idemKey: 'same-key-1234567890',
      },
      'user@example.com'
    );
    const out = await Effect.runPromise(
      Effect.provide(eff, makeAppLayer(db, provider))
    );
    expect(out.paymentId).toBe('prov_existing');
    expect(spy).not.toHaveBeenCalled();
  });
});
