# Real-World Scenario: E-commerce Checkout

**Scenario:** A checkout flow involving Cart Validation, Inventory Checks (parallel), Pricing (parallel), Inventory Reservation, Payment, and Order Creation.
**Key Constraints:** Multiple failure points, diverse error types, need for parallel execution.

See the code: `ecommerce-checkout.test.ts`

## The Approaches

### 1. The Awaitly Approach
*Automatic Error Unions & Flat Flow.*

The main advantage here is **Automatic Error Inference**. The checkout process can fail in 5 different ways (`ValidationError`, `InventoryError`, `PricingError`, `PaymentError`, `OrderError`). Awaitly automatically infers this union type for you.

```typescript
// Type inference works automatically
import { createWorkflow } from 'awaitly/workflow';
import { allAsync, isPromiseRejectedError } from 'awaitly';

const workflow = createWorkflow({ validateCart, checkInventory, getPricing, ... });

return workflow(async (step, deps) => {
  // Parallel execution with error handling
  const inventoryChecks = await step.fromResult(
    () => allAsync(
      validatedCart.items.map(item =>
        deps.checkInventory(item.productId, item.quantity)
      )
    ),
    {
      onError: (error): InventoryError => {
        if (isPromiseRejectedError(error)) {
          return 'OUT_OF_STOCK';
        }
        return error;
      },
      name: 'Check inventory',
      key: `inventory:${cart.userId}`
    }
  );
});
```

**Pros:**
- **Type Safety without Boilerplate:** You don't need to manually type `Result<Order, Error1 | Error2 | Error3 ...>`.
- **Flat Structure:** Async/await keeps the code linear, even with 6+ steps.
- **Early Exit:** If the cart is invalid, it stops immediately. No need to check `.isErr()` after every line.
- **Saga Pattern:** For checkout flows that need rollback (refund payment if shipping fails), Awaitly provides `createSagaWorkflow` with automatic LIFO compensation.

#### Saga Pattern for Checkout

When checkout steps need rollback on failure:

```typescript
import { createSagaWorkflow, isSagaCompensationError } from 'awaitly/saga';

const checkout = createSagaWorkflow({ reserveInventory, chargeCard, scheduleShipping });

const result = await checkout(async (saga, deps) => {
  const reservation = await saga.step(
    () => deps.reserveInventory(items),
    { compensate: (res) => releaseInventory(res.id) }
  );

  const payment = await saga.step(
    () => deps.chargeCard(amount),
    { compensate: (p) => refundPayment(p.transactionId) }
  );

  // If shipping fails, compensations run automatically in reverse order:
  // 1. refundPayment, 2. releaseInventory
  await saga.step(() => deps.scheduleShipping(reservation.id));

  return { reservation, payment };
});
```

### 2. The Neverthrow Approach
*Explicit, but verbose.*

Neverthrow requires you to manually manage the error union types, which can be tedious as the complexity grows. The chaining syntax also makes it harder to access "earlier" variables (like `cart`) deep in the chain without passing them down explicitly.

```typescript
// Requires explicit error typing or loose 'any'
ResultAsync.combine([inventory, pricing])
  .andThen(([inv, price]) => {
     // access 'cart' from 2 scopes up? 
     // You often need to pass it down or nest closures.
  })
```

**Pros:**
- **Explicit:** You know exactly what is happening at every step.
- **Functional:** Great if you prefer `pipe` style data transformations.

**Cons:**
- **Variable Scoping:** Accessing variables from 3 steps ago inside a `.andThen` callback is painful (variable shadowing or drilling).
- **Boilerplate:** Manually constructing large Error Union types.

### 3. The Effect Approach
*Powerful Concurrency.*

Effect shines in the parallel section (`Inventory` + `Pricing`). Its concurrency controls are best-in-class.

```typescript
// Powerful concurrency controls
yield* Effect.all([checkInventory, getPricing], { concurrency: 'unbounded' });
```

**Pros:**
- **Structured Concurrency:** If one parallel task fails, Effect automatically cancels the others to save resources.
- **Generators:** Solves the "Variable Scoping" problem Neverthrow has (all variables in scope).

**Cons:**
- **Types:** While strong, the error types can get complex to read in tooltips.

## Comparison Table

| Feature | Awaitly | Neverthrow | Effect |
| :--- | :--- | :--- | :--- |
| **Error Types** | Auto-inferred Union | Manual Union | Auto-inferred (Generic) |
| **Flow Control** | Linear (Async/Await) | Nested (Callbacks) | Linear (Generators) |
| **Variable Access**| Easy (Block Scope) | Hard (Closure Scope) | Easy (Block Scope) |
| **Parallelism** | Good | Good | Excellent (Interruption) |
| **Saga/Rollback** | Built-in (`createSagaWorkflow`) | Manual | Manual |
| **Circuit Breaker** | Built-in | Manual | Manual |

### Type-Safe Fetch for Checkout APIs (v1.11.0)

For checkout flows calling external APIs, `awaitly/fetch` provides type-safe HTTP operations:

```typescript
import { fetchJson } from 'awaitly/fetch';

// Define custom error types for checkout
type CheckoutApiError =
  | { type: 'INVENTORY_UNAVAILABLE'; productId: string }
  | { type: 'PAYMENT_DECLINED'; reason: string }
  | { type: 'SHIPPING_UNAVAILABLE'; address: string }
  | { type: 'API_ERROR'; status: number };

const checkInventory = (productId: string, quantity: number) =>
  fetchJson<{ available: boolean; reserved?: string }>(
    `/api/inventory/${productId}/check`,
    {
      method: 'POST',
      body: JSON.stringify({ quantity }),
      mapError: (status, body): CheckoutApiError => {
        if (status === 409) {
          return { type: 'INVENTORY_UNAVAILABLE', productId };
        }
        return { type: 'API_ERROR', status };
      },
    }
  );

const processPayment = (paymentData: PaymentRequest) =>
  fetchJson<PaymentResult>('/api/payments', {
    method: 'POST',
    body: JSON.stringify(paymentData),
    mapError: (status, body): CheckoutApiError => {
      if (status === 402) {
        return { type: 'PAYMENT_DECLINED', reason: body?.message ?? 'Unknown' };
      }
      return { type: 'API_ERROR', status };
    },
  });

// Usage in checkout workflow
const checkout = createSagaWorkflow({
  checkInventory,
  processPayment,
  scheduleShipping,
});

const result = await checkout(async (saga, deps) => {
  // Check inventory with typed error
  const inventory = await saga.step(
    () => deps.checkInventory(item.productId, item.quantity),
    { compensate: (inv) => releaseInventory(inv.reserved!) }
  );

  // Process payment with typed error
  const payment = await saga.step(
    () => deps.processPayment({ amount, card }),
    { compensate: (p) => refundPayment(p.transactionId) }
  );

  return { orderId: payment.orderId };
});

// Handle specific checkout errors
if (!result.ok) {
  switch (result.error.type) {
    case 'INVENTORY_UNAVAILABLE':
      return { error: `Product ${result.error.productId} is out of stock` };
    case 'PAYMENT_DECLINED':
      return { error: `Payment declined: ${result.error.reason}` };
    case 'SHIPPING_UNAVAILABLE':
      return { error: 'Shipping not available to your address' };
  }
}
```

**Benefits:**
- Type-safe error mapping from HTTP status codes
- Automatic error type inference in workflows
- No manual Result wrapping of fetch calls
- Built-in handling of network errors

## Conclusion

For **Complex Business Logic (like Checkout)**:
- **Awaitly** is the winner for **DX** and **Production Reliability**. Automatic error inference, familiar async/await syntax, built-in saga pattern for rollback scenarios, plus type-safe fetch helpers for external APIs.
- **Effect** is the winner for **Structured Concurrency**. If you need fiber-based cancellation and are comfortable with functional programming.
- **Neverthrow** is solid for simple cases but gets verbose with complex variable dependencies and lacks built-in reliability features.
