# Real-World Scenario: E-commerce Checkout

**Scenario:** A checkout flow involving Cart Validation, Inventory Checks (parallel), Pricing (parallel), Inventory Reservation, Payment, and Order Creation.
**Key Constraints:** Multiple failure points, diverse error types, need for parallel execution.

See the code: `ecommerce-checkout.test.ts`

## The Approaches

### 1. The Awaitly Approach

*This scenario uses `createWorkflow` because checkout needs parallel steps and automatic error inference. For typed Results without workflows, see [api-comparison.md §1–2](./api-comparison.md).*

*Automatic Error Unions & Flat Flow.*

The main advantage here is **Automatic Error Inference**. The checkout process can fail in 5 different ways (`ValidationError`, `InventoryError`, `PricingError`, `PaymentError`, `OrderError`). Awaitly automatically infers this union type for you.

```typescript
// Type inference works automatically
import { createWorkflow, allAsync } from 'awaitly';

const workflow = createWorkflow('checkout', { validateCart, checkInventory, getPricing, ... });

return workflow.run(async ({ step, deps }) => {
  // Parallel execution — the error type is exactly InventoryError
  const inventoryChecks = await step(
    'checkInventory',
    () => allAsync(
      validatedCart.items.map(item =>
        deps.checkInventory(item.productId, item.quantity)
      )
    ),
    { key: `inventory:${cart.userId}` }
  );
});
```

**Awaitly 4 removed a failure mode here.** In Awaitly 3, `allAsync` caught promise rejections and reported `PromiseRejectedError`, so every caller had to widen its union and remap that case back into the domain (`isPromiseRejectedError(error) ? 'OUT_OF_STOCK' : error`) — a `step.fromResult` with an `onError` mapper just to launder an error nobody modelled. A rejection is a thrown exception, and `UnexpectedError` already covers those, so `allAsync` and `anyAsync` no longer report it. The parallel inventory check is now a plain `step()` whose error type is exactly the union the deps declare.

Two related tightenings: `any` / `anyAsync` now require a non-empty array (an empty one is a compile error, and `EmptyInputError` is gone from the return type), and when every racer in `anyAsync` fails, a modelled error always wins over a thrown one instead of whichever settled first. `allSettledAsync` is unchanged — reporting every outcome, `PromiseRejectedError` included, is what it is for.

**Pros:**
- **Type Safety without Boilerplate:** You don't need to manually type `Result<Order, Error1 | Error2 | Error3 ...>`.
- **Flat Structure:** Async/await keeps the code linear, even with 6+ steps.
- **Early Exit:** If the cart is invalid, it stops immediately. No need to check `.isErr()` after every line.
- **Saga Pattern:** For checkout flows that need rollback (refund payment if shipping fails), Awaitly provides `createSagaWorkflow` with automatic LIFO compensation.

#### Saga Pattern for Checkout

When checkout steps need rollback on failure:

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
  const reservation = await step(
    'reserveInventory',
    () => deps.reserveInventory(items),
    { compensate: (res) => deps.releaseInventory(res.id) },
  );

  const payment = await step(
    'chargeCard',
    () => deps.chargeCard(amount),
    { compensate: (p) => deps.refundPayment(p.transactionId) },
  );

  // If shipping fails, compensations run automatically in reverse order:
  // 1. refundPayment, 2. releaseInventory
  await step('scheduleShipping', () => deps.scheduleShipping(reservation.id));

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

### HTTP Boundaries with Awaitly 4

Awaitly 4 has no `awaitly/fetch`. Use native `fetch` and wrap the boundary with `tryAsync`, mapping transport and status failures into the checkout domain error union. This keeps HTTP policy application-specific while preserving typed workflow errors.

## Conclusion

For **Complex Business Logic (like Checkout)**:
- **Awaitly** is the winner for **DX** and **Production Reliability**. Automatic error inference, familiar async/await syntax, built-in saga pattern for rollback scenarios, plus type-safe fetch helpers for external APIs.
- **Effect** is the winner for **Structured Concurrency**. If you need fiber-based cancellation and are comfortable with functional programming.
- **Neverthrow** is solid for simple cases but gets verbose with complex variable dependencies and lacks built-in reliability features.
