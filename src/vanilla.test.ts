import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// --- Types / errors
export type Currency = 'GBP' | 'EUR' | 'USD';
export type ProviderResponse = {
  id: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
};

export class ValidationError extends Error {}
export class IdempotencyConflict extends Error {}
export class ProviderUnavailable extends Error {}
export class ProviderSoftFail extends Error {} // 429/5xx retriable
export class ProviderHardFail extends Error {} // 4xx non-retriable
export class PersistError extends Error {}
export class TimeoutError extends Error {}

// --- Ports (DB + Provider)
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

// --- Input schema
const CreatePayment = z.object({
  clientId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.enum(['GBP', 'EUR', 'USD']),
  reference: z.string().min(1),
  idemKey: z.string().min(16),
});
type CreatePayment = z.infer<typeof CreatePayment>;

// --- Helper: timeout + retry (exponential backoff)
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

async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseMs: number
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ProviderSoftFail || e instanceof TimeoutError))
        throw e;
      const backoff =
        Math.min(baseMs * 2 ** i, 3000) + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// --- Error mapping for provider responses
function mapHttpError(status: number, body?: unknown): Error {
  if (status === 429 || status >= 500)
    return new ProviderSoftFail(`Provider ${status}`);
  if (status >= 400)
    return new ProviderHardFail(`Provider ${status}: ${JSON.stringify(body)}`);
  return new Error('Unknown provider error');
}

// --- Use case
export async function createPaymentVanilla(
  db: Db,
  provider: Provider,
  raw: unknown,
  actorEmail: string
): Promise<{ paymentId: string }> {
  // 1) Validate
  const parsed = CreatePayment.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.message);
  const input = parsed.data;

  // 2) Idempotency (fast path)
  const existing = await db.findPaymentByKey(input.idemKey);
  if (existing) return { paymentId: existing.id };

  // 3) Acquire lock to avoid dupes racing
  const locked = await db.acquireLock(input.idemKey);
  if (!locked) throw new IdempotencyConflict('Concurrent request');

  // 4) Call provider (timeout + retry on soft failures)
  const providerCall = async () => {
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

  let pResp: ProviderResponse;
  try {
    pResp = await retry(providerCall, 3, 200);
  } catch (e) {
    if (e instanceof ProviderSoftFail || e instanceof TimeoutError) {
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
        .catch(() => {
          /* swallow persist errors here or log */
        });
      throw new ProviderUnavailable(String(e));
    }
    throw e;
  }

  // 5) Persist success/final state
  try {
    await db.transaction(async (tx) => {
      await tx.insertPayment({
        clientId: input.clientId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        providerPaymentId: pResp.id,
        status: pResp.status,
        idemKey: input.idemKey,
      });
      await tx.insertAudit({
        actor: actorEmail,
        action: 'PAYMENT_CREATED',
        metadata: { providerId: pResp.id },
      });
    });
  } catch (e) {
    throw new PersistError(String(e));
  }

  // 6) Return
  return { paymentId: pResp.id };
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

describe('vanilla', () => {
  it('creates payment happy path', async () => {
    const db = makeDb();
    const provider = makeProvider();
    const out = await createPaymentVanilla(
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
    expect(out.paymentId).toBe('prov_ref1');
  });

  it('fails validation on bad input', async () => {
    const db = makeDb();
    const provider = makeProvider();
    await expect(
      createPaymentVanilla(
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
      )
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('conflicts when lock not acquired', async () => {
    const db: Db = {
      ...makeDb(),
      acquireLock: async () => false,
    } as Db;
    const provider = makeProvider();
    await expect(
      createPaymentVanilla(
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
      )
    ).rejects.toBeInstanceOf(IdempotencyConflict);
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
    await expect(
      createPaymentVanilla(
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
      )
    ).rejects.toBeInstanceOf(ProviderHardFail);
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
    await expect(
      createPaymentVanilla(
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
      )
    ).rejects.toBeInstanceOf(ProviderUnavailable);
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
    const out = await createPaymentVanilla(
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
    expect(out.paymentId).toBe('prov_existing');
    expect(spy).not.toHaveBeenCalled();
  });
});
