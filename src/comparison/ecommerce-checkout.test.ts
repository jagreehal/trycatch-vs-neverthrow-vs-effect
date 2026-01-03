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
import { ok, err, allAsync, type AsyncResult } from '@jagreehal/workflow';
import { createWorkflow } from '@jagreehal/workflow';

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
type InventoryError = 'OUT_OF_STOCK' | 'INSUFFICIENT_QUANTITY';
type PricingError = 'PRICING_UNAVAILABLE' | 'PRICE_CHANGED';
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
    throw new Error('OUT_OF_STOCK');
  }
  
  if (productId === 'low-stock' && quantity > 2) {
    throw new Error('INSUFFICIENT_QUANTITY');
  }
  
  return { productId, available: 100, reserved: 0 };
};

const getPricingImpl = async (productId: ProductId): Promise<Price> => {
  await new Promise(resolve => setTimeout(resolve, 15));
  
  if (productId === 'unpriced') {
    throw new Error('PRICING_UNAVAILABLE');
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
    throw new Error('PAYMENT_DECLINED');
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

const validateCart = async (cart: Cart): AsyncResult<Cart, ValidationError> => {
  const result = validateCartImpl(cart);
  return result.isOk() ? ok(result.value) : err(result.error);
};

const checkInventory = async (
  productId: ProductId,
  quantity: number
): AsyncResult<Inventory, InventoryError> => {
  try {
    const inventory = await checkInventoryImpl(productId, quantity);
    return ok(inventory);
  } catch (e: any) {
    return err(e.message as InventoryError);
  }
};

const getPricing = async (productId: ProductId): AsyncResult<Price, PricingError> => {
  try {
    const price = await getPricingImpl(productId);
    return ok(price);
  } catch (e: any) {
    return err(e.message as PricingError);
  }
};

const reserveInventory = async (
  productId: ProductId,
  quantity: number
): AsyncResult<void, InventoryError> => {
  try {
    await reserveInventoryImpl(productId, quantity);
    return ok(undefined);
  } catch (e: any) {
    return err(e.message as InventoryError);
  }
};

const processPayment = async (
  paymentMethod: PaymentMethod,
  amount: number
): AsyncResult<{ transactionId: string }, PaymentError> => {
  try {
    const payment = await processPaymentImpl(paymentMethod, amount);
    return ok(payment);
  } catch (e: any) {
    return err(e.message as PaymentError);
  }
};

const createOrder = async (
  userId: UserId,
  items: CartItem[],
  total: number,
  transactionId: string
): AsyncResult<Order, OrderError> => {
  try {
    const order = await createOrderImpl(userId, items, total, transactionId);
    return ok(order);
  } catch {
    return err('ORDER_CREATION_FAILED');
  }
};

export async function checkoutWorkflow(
  cart: Cart,
  paymentMethod: PaymentMethod
): AsyncResult<Order, CheckoutError> {
  const deps = {
    validateCart: () => validateCart(cart),
    checkInventory: (productId: ProductId, quantity: number) =>
      checkInventory(productId, quantity),
    getPricing: (productId: ProductId) => getPricing(productId),
    reserveInventory: (productId: ProductId, quantity: number) =>
      reserveInventory(productId, quantity),
    processPayment: (amount: number) => processPayment(paymentMethod, amount),
    createOrder: (items: CartItem[], total: number, transactionId: string) =>
      createOrder(cart.userId, items, total, transactionId),
  };

  const workflow = createWorkflow(deps);

  return workflow(async (step, deps) => {
    const validatedCart = await step(() => deps.validateCart(), {
      name: 'Validate cart',
      key: `validate:${cart.userId}`,
    });

    const inventoryChecks = await step(
      () => allAsync(
        validatedCart.items.map(item =>
          deps.checkInventory(item.productId, item.quantity)
        )
      ),
      {
        name: 'Check inventory',
        key: `inventory:${cart.userId}`,
      }
    );

    const pricingChecks = await step(
      () => allAsync(
        validatedCart.items.map(item =>
          deps.getPricing(item.productId)
        )
      ),
      {
        name: 'Get pricing',
        key: `pricing:${cart.userId}`,
      }
    );

    await step(
      () => allAsync(
        validatedCart.items.map(item =>
          deps.reserveInventory(item.productId, item.quantity)
        )
      ),
      {
        name: 'Reserve inventory',
        key: `reserve:${cart.userId}`,
      }
    );

    const total = pricingChecks.reduce((sum, price, i) => {
      return sum + price.amount * validatedCart.items[i].quantity;
    }, 0);

    const payment = await step(() => deps.processPayment(total), {
      name: 'Process payment',
      key: `payment:${paymentMethod.id}:${total}`,
    });

    const order = await step(
      () => deps.createOrder(validatedCart.items, total, payment.transactionId),
      {
        name: 'Create order',
        key: `order:${payment.transactionId}`,
      }
    );

    return order;
  });
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
    (e: any) => e.message as InventoryError
  );

const getPricingNt = (productId: ProductId): ResultAsync<Price, PricingError> =>
  ResultAsync.fromPromise(
    getPricingImpl(productId),
    (e: any) => e.message as PricingError
  );

const reserveInventoryNt = (
  productId: ProductId,
  quantity: number
): ResultAsync<void, InventoryError> =>
  ResultAsync.fromPromise(
    reserveInventoryImpl(productId, quantity),
    (e: any) => e.message as InventoryError
  );

const processPaymentNt = (
  paymentMethod: PaymentMethod,
  amount: number
): ResultAsync<{ transactionId: string }, PaymentError> =>
  ResultAsync.fromPromise(
    processPaymentImpl(paymentMethod, amount),
    (e: any) => e.message as PaymentError
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
    catch: (e: any) => e.message as InventoryError,
  });

const getPricingEffect = (productId: ProductId): Effect.Effect<Price, PricingError> =>
  Effect.tryPromise({
    try: () => getPricingImpl(productId),
    catch: (e: any) => e.message as PricingError,
  });

const reserveInventoryEffect = (
  productId: ProductId,
  quantity: number
): Effect.Effect<void, InventoryError> =>
  Effect.tryPromise({
    try: () => reserveInventoryImpl(productId, quantity),
    catch: (e: any) => e.message as InventoryError,
  });

const processPaymentEffect = (
  paymentMethod: PaymentMethod,
  amount: number
): Effect.Effect<{ transactionId: string }, PaymentError> =>
  Effect.tryPromise({
    try: () => processPaymentImpl(paymentMethod, amount),
    catch: (e: any) => e.message as PaymentError,
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
      Effect.all(validatedCart.items.map(item =>
        checkInventoryEffect(item.productId, item.quantity)
      ), { concurrency: 'unbounded' }),
      Effect.all(validatedCart.items.map(item =>
        getPricingEffect(item.productId)
      ), { concurrency: 'unbounded' }),
    ], { concurrency: 'unbounded' });

    yield* Effect.all(
      validatedCart.items.map(item =>
        reserveInventoryEffect(item.productId, item.quantity)
      ),
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
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBe('EMPTY_CART');
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
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBe('OUT_OF_STOCK');
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
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBe('INSUFFICIENT_QUANTITY');
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
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBe('PAYMENT_DECLINED');
      }
    });
  });
});
