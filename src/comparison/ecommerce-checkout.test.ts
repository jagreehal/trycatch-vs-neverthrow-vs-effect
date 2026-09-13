/**
 * Real-World Scenario: E-commerce Checkout Flow
 * 
 * This scenario demonstrates:
 * - Complex multi-step workflows with dependencies
 * - Automatic error type inference
 * - Step caching for idempotency
 * - Visualization of workflow execution
 * - Parallel operations (inventory + pricing)
 * 
 * Compare implementations across workflow, neverthrow, and effect.
 */

import { describe, it, expect } from 'vitest';
import { ResultAsync, errAsync, Result, ok as ntOk, err as ntErr } from 'neverthrow';
import { Effect } from 'effect';
import {
  ok,
  err,
  allAsync,
  tryAsync,
  createWorkflow,
  type AsyncResult,
  type UnexpectedError,
} from 'awaitly';

// ============================================================================
// Shared Types & Errors
// ============================================================================

type UserId = string;
type ProductId = string;
type CartItem = { productId: ProductId; quantity: number };
type Cart = { userId: UserId; items: CartItem[] };
type Inventory = { productId: ProductId; available: number; reserved: number };
type Price = { productId: ProductId; amount: number; currency: string };
type PaymentMethod = { id: string; type: 'card' | 'paypal' };
type Order = { id: string; userId: UserId; total: number; status: 'pending' | 'confirmed' };

type ValidationError = 'INVALID_CART' | 'EMPTY_CART';
type InventoryError = 'OUT_OF_STOCK' | 'INSUFFICIENT_QUANTITY' | 'INVENTORY_UNAVAILABLE';
type PricingError = 'PRICING_UNAVAILABLE' | 'PRICE_CHANGED';

/**
 * Dependencies throw this rather than a bare Error, so each boundary mapper
 * reads a discriminant instead of matching on `e.message`. An exception that
 * is not a DependencyFailure is a bug rather than a modelled outcome, and the
 * mappers below report it as the domain's "unavailable" case instead of
 * guessing at a more specific one.
 */
// `code` is the discriminant here, and this type is thrown and mapped at the
// boundary rather than carried in an inferred error union.
// eslint-disable-next-line awaitly/error-require-discriminant
class DependencyFailure<Code extends string> extends Error {
  constructor(readonly code: Code) {
    super(code);
    this.name = 'DependencyFailure';
  }
}

const failureCode = <Code extends string>(e: unknown): Code | undefined =>
  e instanceof DependencyFailure ? (e.code as Code) : undefined;
type PaymentError = 'PAYMENT_DECLINED' | 'PAYMENT_TIMEOUT';
type OrderError = 'ORDER_CREATION_FAILED';

type CheckoutError = ValidationError | InventoryError | PricingError | PaymentError | OrderError;

// ============================================================================
// Shared Dependencies
// ============================================================================

const validateCartImpl = (cart: Cart): Result<Cart, ValidationError> => {
  if (!cart.userId || cart.items.length === 0) {
    return ntErr('EMPTY_CART');
  }
  if (cart.items.some(item => item.quantity <= 0)) {
    return ntErr('INVALID_CART');
  }
  return ntOk(cart);
};

const checkInventoryImpl = async (
  productId: ProductId,
  quantity: number
): Promise<Inventory> => {
  await new Promise(resolve => setTimeout(resolve, 10));
  
  if (productId === 'out-of-stock') {
    throw new DependencyFailure('OUT_OF_STOCK');
  }

  if (productId === 'low-stock' && quantity > 2) {
    throw new DependencyFailure('INSUFFICIENT_QUANTITY');
  }

  if (productId === 'inventory-offline') {
    // An unmodelled failure: the mapper must not label this OUT_OF_STOCK.
    throw new TypeError('connection reset');
  }
  
  return { productId, available: 100, reserved: 0 };
};

const getPricingImpl = async (productId: ProductId): Promise<Price> => {
  await new Promise(resolve => setTimeout(resolve, 15));
  
  if (productId === 'unpriced') {
    throw new DependencyFailure('PRICING_UNAVAILABLE');
  }
  
  return { productId, amount: 29.99, currency: 'USD' };
};

const reserveInventoryImpl = async (
  productId: ProductId,
  quantity: number
): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 20));
};

const processPaymentImpl = async (
  paymentMethod: PaymentMethod,
  amount: number
): Promise<{ transactionId: string }> => {
  await new Promise(resolve => setTimeout(resolve, 50));
  
  if (paymentMethod.id === 'declined-card') {
    throw new DependencyFailure('PAYMENT_DECLINED');
  }
  
  return { transactionId: `txn_${Date.now()}` };
};

const createOrderImpl = async (
  userId: UserId,
  items: CartItem[],
  total: number,
  transactionId: string
): Promise<Order> => {
  await new Promise(resolve => setTimeout(resolve, 10));
  
  return {
    id: `order_${Date.now()}`,
    userId,
    total,
    status: 'confirmed',
  };
};

// ============================================================================
// Workflow Implementation
// ============================================================================

const validateCart = (cart: Cart): AsyncResult<Cart, ValidationError> =>
  Promise.resolve(validateCartImpl(cart)).then(result =>
    result.isOk() ? ok(result.value) : err(result.error)
  );

const checkInventory = (
  productId: ProductId,
  quantity: number
): AsyncResult<Inventory, InventoryError> =>
  tryAsync(
    async () => await checkInventoryImpl(productId, quantity),
    (e) => failureCode<InventoryError>(e) ?? 'INVENTORY_UNAVAILABLE'
  );

const getPricing = (productId: ProductId): AsyncResult<Price, PricingError> =>
  tryAsync(
    async () => await getPricingImpl(productId),
    (e) => failureCode<PricingError>(e) ?? 'PRICING_UNAVAILABLE'
  );

const reserveInventory = (
  productId: ProductId,
  quantity: number
): AsyncResult<void, InventoryError> =>
  tryAsync(
    async () => await reserveInventoryImpl(productId, quantity),
    (e) => failureCode<InventoryError>(e) ?? 'INVENTORY_UNAVAILABLE'
  );

const processPayment = (
  paymentMethod: PaymentMethod,
  amount: number
): AsyncResult<{ transactionId: string }, PaymentError> =>
  tryAsync(
    async () => await processPaymentImpl(paymentMethod, amount),
    (e) => failureCode<PaymentError>(e) ?? 'PAYMENT_TIMEOUT'
  );

const createOrder = (
  userId: UserId,
  items: CartItem[],
  total: number,
  transactionId: string
): AsyncResult<Order, OrderError> =>
  tryAsync(
    async () => await createOrderImpl(userId, items, total, transactionId),
    () => 'ORDER_CREATION_FAILED'
  );

const checkoutDeps = {
  validateCart,
  checkInventory,
  getPricing,
  reserveInventory,
  processPayment,
  createOrder,
};

export async function checkoutWorkflow(
  cart: Cart,
  paymentMethod: PaymentMethod,
  overrides?: Partial<typeof checkoutDeps>
): AsyncResult<Order, CheckoutError | UnexpectedError> {
  const workflow = createWorkflow('checkout', checkoutDeps);

  return workflow.run(
    'checkout',
    async ({ step, deps }) => {
    const validatedCart = await step('validateCart', () => deps.validateCart(cart), {
      description: 'Validate cart',
      key: `validate:${cart.userId}`,
    });

    const inventoryChecks = await step(
      'checkInventory',
      () => allAsync(
        validatedCart.items.map((item: { productId: string; quantity: number }) =>
          deps.checkInventory(item.productId, item.quantity)
        )
      ),
      { key: `inventory:${cart.userId}` }
    );
    void inventoryChecks;

    const pricingChecks = await step(
      'getPricing',
      () => allAsync(
        validatedCart.items.map((item: { productId: string; quantity: number }) =>
          deps.getPricing(item.productId)
        )
      ),
      { key: `pricing:${cart.userId}` }
    );

    await step(
      'reserveInventory',
      () => allAsync(
        validatedCart.items.map((item: { productId: string; quantity: number }) =>
          deps.reserveInventory(item.productId, item.quantity)
        )
      ),
      { key: `reserve:${cart.userId}` }
    );

    const total = pricingChecks.reduce((sum: number, price: Price, i: number) => {
      return sum + price.amount * validatedCart.items[i].quantity;
    }, 0);

    const payment = await step('processPayment', () => deps.processPayment(paymentMethod, total), {
      description: 'Process payment',
      key: `payment:${paymentMethod.id}:${total}`,
    });

    const order = await step(
      'createOrder',
      () => deps.createOrder(cart.userId, validatedCart.items, total, payment.transactionId),
      {
        description: 'Create order',
        key: `order:${payment.transactionId}`,
      }
    );

      return order;
    },
    // Overrides let a caller substitute any dependency; the workflow body
    // calls deps.*, so the injected implementation is the one that runs.
    { deps: { ...checkoutDeps, ...overrides } }
  );
}

// ============================================================================
// Neverthrow Implementation
// ============================================================================

const validateCartNt = (cart: Cart): Result<Cart, ValidationError> =>
  validateCartImpl(cart);

const checkInventoryNt = (
  productId: ProductId,
  quantity: number
): ResultAsync<Inventory, InventoryError> =>
  ResultAsync.fromPromise(
    checkInventoryImpl(productId, quantity),
    (e) => failureCode<InventoryError>(e) ?? 'INVENTORY_UNAVAILABLE'
  );

const getPricingNt = (productId: ProductId): ResultAsync<Price, PricingError> =>
  ResultAsync.fromPromise(
    getPricingImpl(productId),
    (e) => failureCode<PricingError>(e) ?? 'PRICING_UNAVAILABLE'
  );

const reserveInventoryNt = (
  productId: ProductId,
  quantity: number
): ResultAsync<void, InventoryError> =>
  ResultAsync.fromPromise(
    reserveInventoryImpl(productId, quantity),
    (e) => failureCode<InventoryError>(e) ?? 'INVENTORY_UNAVAILABLE'
  );

const processPaymentNt = (
  paymentMethod: PaymentMethod,
  amount: number
): ResultAsync<{ transactionId: string }, PaymentError> =>
  ResultAsync.fromPromise(
    processPaymentImpl(paymentMethod, amount),
    (e) => failureCode<PaymentError>(e) ?? 'PAYMENT_TIMEOUT'
  );

const createOrderNt = (
  userId: UserId,
  items: CartItem[],
  total: number,
  transactionId: string
): ResultAsync<Order, OrderError> =>
  ResultAsync.fromPromise(
    createOrderImpl(userId, items, total, transactionId),
    () => 'ORDER_CREATION_FAILED' as const
  );

export function checkoutNeverthrow(
  cart: Cart,
  paymentMethod: PaymentMethod
): ResultAsync<Order, CheckoutError> {
  const validatedCartResult = validateCartNt(cart);
  
  if (validatedCartResult.isErr()) {
    return errAsync(validatedCartResult.error);
  }
  
  const validatedCart = validatedCartResult.value;
  
  const inventoryChecks = ResultAsync.combine(
    validatedCart.items.map(item =>
      checkInventoryNt(item.productId, item.quantity)
    )
  );

  const pricingChecks = ResultAsync.combine(
    validatedCart.items.map(item =>
      getPricingNt(item.productId)
    )
  );

  return ResultAsync.combine([inventoryChecks, pricingChecks])
    .andThen(([inventories, prices]) => {
      const reserveOps = validatedCart.items.map(item =>
        reserveInventoryNt(item.productId, item.quantity)
      );

      return ResultAsync.combine(reserveOps)
        .andThen(() => {
          const total = prices.reduce((sum, price, i) => {
            return sum + price.amount * validatedCart.items[i].quantity;
          }, 0);

          return processPaymentNt(paymentMethod, total)
            .andThen((payment) =>
              createOrderNt(cart.userId, validatedCart.items, total, payment.transactionId)
            );
        });
    });
}

// ============================================================================
// Effect Implementation
// ============================================================================

const validateCartEffect = (cart: Cart): Effect.Effect<Cart, ValidationError> => {
  const result = validateCartImpl(cart);
  return result.isOk() ? Effect.succeed(result.value) : Effect.fail(result.error);
};

const checkInventoryEffect = (
  productId: ProductId,
  quantity: number
): Effect.Effect<Inventory, InventoryError> =>
  Effect.tryPromise({
    try: () => checkInventoryImpl(productId, quantity),
    catch: (e) => failureCode<InventoryError>(e) ?? 'INVENTORY_UNAVAILABLE',
  });

const getPricingEffect = (productId: ProductId): Effect.Effect<Price, PricingError> =>
  Effect.tryPromise({
    try: () => getPricingImpl(productId),
    catch: (e) => failureCode<PricingError>(e) ?? 'PRICING_UNAVAILABLE',
  });

const reserveInventoryEffect = (
  productId: ProductId,
  quantity: number
): Effect.Effect<void, InventoryError> =>
  Effect.tryPromise({
    try: () => reserveInventoryImpl(productId, quantity),
    catch: (e) => failureCode<InventoryError>(e) ?? 'INVENTORY_UNAVAILABLE',
  });

const processPaymentEffect = (
  paymentMethod: PaymentMethod,
  amount: number
): Effect.Effect<{ transactionId: string }, PaymentError> =>
  Effect.tryPromise({
    try: () => processPaymentImpl(paymentMethod, amount),
    catch: (e) => failureCode<PaymentError>(e) ?? 'PAYMENT_TIMEOUT',
  });

const createOrderEffect = (
  userId: UserId,
  items: CartItem[],
  total: number,
  transactionId: string
): Effect.Effect<Order, OrderError> =>
  Effect.tryPromise({
    try: () => createOrderImpl(userId, items, total, transactionId),
    catch: () => 'ORDER_CREATION_FAILED' as const,
  });

export const checkoutEffect = (
  cart: Cart,
  paymentMethod: PaymentMethod
): Effect.Effect<Order, CheckoutError> =>
  Effect.gen(function* () {
    const validatedCart = yield* validateCartEffect(cart);

    const [inventories, prices] = yield* Effect.all([
      Effect.forEach(validatedCart.items, item =>
        checkInventoryEffect(item.productId, item.quantity),
        { concurrency: 'unbounded' }),
      Effect.forEach(validatedCart.items, item =>
        getPricingEffect(item.productId),
        { concurrency: 'unbounded' }),
    ], { concurrency: 'unbounded' });
    void inventories;

    yield* Effect.forEach(
      validatedCart.items,
      item => reserveInventoryEffect(item.productId, item.quantity),
      { concurrency: 'unbounded' }
    );

    const total = prices.reduce((sum, price, i) => {
      return sum + price.amount * validatedCart.items[i].quantity;
    }, 0);

    const payment = yield* processPaymentEffect(paymentMethod, total);
    return yield* createOrderEffect(cart.userId, validatedCart.items, total, payment.transactionId);
  });

// ============================================================================
// Tests
// ============================================================================

const makeCart = (items: CartItem[]): Cart => ({
  userId: 'user-123',
  items,
});

const makePaymentMethod = (id: string): PaymentMethod => ({
  id,
  type: 'card',
});

describe('E-commerce Checkout', () => {
  describe('Workflow', () => {
    it('successfully completes checkout', async () => {
      const result = await checkoutWorkflow(
        makeCart([
          { productId: 'prod-1', quantity: 2 },
          { productId: 'prod-2', quantity: 1 },
        ]),
        makePaymentMethod('card-123')
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('confirmed');
        expect(result.value.userId).toBe('user-123');
      }
    });

    it('fails on empty cart', async () => {
      const result = await checkoutWorkflow(
        makeCart([]),
        makePaymentMethod('card-123')
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('EMPTY_CART');
      }
    });

    it('fails on out of stock', async () => {
      const result = await checkoutWorkflow(
        makeCart([{ productId: 'out-of-stock', quantity: 1 }]),
        makePaymentMethod('card-123')
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('OUT_OF_STOCK');
      }
    });

    it('fails on insufficient quantity', async () => {
      const result = await checkoutWorkflow(
        makeCart([{ productId: 'low-stock', quantity: 5 }]),
        makePaymentMethod('card-123')
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('INSUFFICIENT_QUANTITY');
      }
    });

    it('fails on payment decline', async () => {
      const result = await checkoutWorkflow(
        makeCart([{ productId: 'prod-1', quantity: 1 }]),
        makePaymentMethod('declined-card')
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('PAYMENT_DECLINED');
      }
    });
  });

  describe('Neverthrow', () => {
    it('successfully completes checkout', async () => {
      const result = await checkoutNeverthrow(
        makeCart([
          { productId: 'prod-1', quantity: 2 },
          { productId: 'prod-2', quantity: 1 },
        ]),
        makePaymentMethod('card-123')
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.status).toBe('confirmed');
        expect(result.value.userId).toBe('user-123');
      }
    });

    it('fails on empty cart', async () => {
      const result = await checkoutNeverthrow(
        makeCart([]),
        makePaymentMethod('card-123')
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe('EMPTY_CART');
      }
    });

    it('fails on out of stock', async () => {
      const result = await checkoutNeverthrow(
        makeCart([{ productId: 'out-of-stock', quantity: 1 }]),
        makePaymentMethod('card-123')
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe('OUT_OF_STOCK');
      }
    });

    it('fails on insufficient quantity', async () => {
      const result = await checkoutNeverthrow(
        makeCart([{ productId: 'low-stock', quantity: 5 }]),
        makePaymentMethod('card-123')
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe('INSUFFICIENT_QUANTITY');
      }
    });

    it('fails on payment decline', async () => {
      const result = await checkoutNeverthrow(
        makeCart([{ productId: 'prod-1', quantity: 1 }]),
        makePaymentMethod('declined-card')
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe('PAYMENT_DECLINED');
      }
    });
  });

  describe('Effect', () => {
    it('successfully completes checkout', async () => {
      const result = await Effect.runPromise(
        checkoutEffect(
          makeCart([
            { productId: 'prod-1', quantity: 2 },
            { productId: 'prod-2', quantity: 1 },
          ]),
          makePaymentMethod('card-123')
        )
      );

      expect(result.status).toBe('confirmed');
      expect(result.userId).toBe('user-123');
    });

    it('fails on empty cart', async () => {
      const exit = await Effect.runPromiseExit(
        checkoutEffect(
          makeCart([]),
          makePaymentMethod('card-123')
        )
      );

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause.reasons[0]?._tag === 'Fail') {
        expect(exit.cause.reasons[0].error).toBe('EMPTY_CART');
      }
    });

    it('fails on out of stock', async () => {
      const exit = await Effect.runPromiseExit(
        checkoutEffect(
          makeCart([{ productId: 'out-of-stock', quantity: 1 }]),
          makePaymentMethod('card-123')
        )
      );

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause.reasons[0]?._tag === 'Fail') {
        expect(exit.cause.reasons[0].error).toBe('OUT_OF_STOCK');
      }
    });

    it('fails on insufficient quantity', async () => {
      const exit = await Effect.runPromiseExit(
        checkoutEffect(
          makeCart([{ productId: 'low-stock', quantity: 5 }]),
          makePaymentMethod('card-123')
        )
      );

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause.reasons[0]?._tag === 'Fail') {
        expect(exit.cause.reasons[0].error).toBe('INSUFFICIENT_QUANTITY');
      }
    });

    it('fails on payment decline', async () => {
      const exit = await Effect.runPromiseExit(
        checkoutEffect(
          makeCart([{ productId: 'prod-1', quantity: 1 }]),
          makePaymentMethod('declined-card')
        )
      );

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause.reasons[0]?._tag === 'Fail') {
        expect(exit.cause.reasons[0].error).toBe('PAYMENT_DECLINED');
      }
    });
  });
});

// ============================================================================
// Dependency injection
// ============================================================================

describe('Checkout dependency injection', () => {
  it('runs the injected payment implementation instead of the module-level one', async () => {
    const charged: number[] = [];

    const result = await checkoutWorkflow(
      makeCart([{ productId: 'p1', quantity: 1 }]),
      makePaymentMethod('card-1'),
      {
        processPayment: async (_method, amount) => {
          charged.push(amount);
          return ok({ transactionId: 'txn_injected' });
        },
      }
    );

    expect(result.ok).toBe(true);
    expect(charged).toEqual([29.99]);
  });
});

// ============================================================================
// Error mapping at the boundary
// ============================================================================

describe('Checkout error mapping', () => {
  it('reports the specific inventory error the dependency raised', async () => {
    const result = await checkInventory('low-stock', 5);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INSUFFICIENT_QUANTITY');
    }
  });

  it('reports a pricing failure as PRICING_UNAVAILABLE', async () => {
    const result = await getPricing('unpriced');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('PRICING_UNAVAILABLE');
    }
  });

  it('surfaces an unmodelled inventory failure rather than mislabelling it', async () => {
    const result = await checkInventory('inventory-offline', 1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('INVENTORY_UNAVAILABLE');
    }
  });
});
