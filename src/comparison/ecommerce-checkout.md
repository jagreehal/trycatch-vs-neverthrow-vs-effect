# Real-World Scenario: E-commerce Checkout

**Scenario:** A checkout flow involving Cart Validation, Inventory Checks (parallel), Pricing (parallel), Inventory Reservation, Payment, and Order Creation.
**Key Constraints:** Multiple failure points, diverse error types, need for parallel execution.

See the code: `ecommerce-checkout.test.ts`

## The Approaches

### 1. The awaitly Approach
*Automatic Error Unions & Flat Flow.*

The "killer feature" here is **Automatic Error Inference**. The checkout process can fail in 5 different ways (`ValidationError`, `InventoryError`, `PricingError`, `PaymentError`, `OrderError`). awaitly automatically infers this union type for you.

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

| Feature | awaitly | Neverthrow | Effect |
| :--- | :--- | :--- | :--- |
| **Error Types** | Auto-inferred Union | Manual Union | Auto-inferred (Generic) |
| **Flow Control** | Linear (Async/Await) | Nested (Callbacks) | Linear (Generators) |
| **Variable Access**| Easy (Block Scope) | Hard (Closure Scope) | Easy (Block Scope) |
| **Parallelism** | Good | Good | Excellent (Interruption) |

## Conclusion

For **Complex Business Logic (like Checkout)**:
- **awaitly** is the winner for **DX**. The automatic error inference and linear async/await syntax match how most developers think about business processes.
- **Effect** is the winner for **Performance/Safety**. Structured concurrency ensures no wasted resources on failure.
- **Neverthrow** is solid but gets verbose with complex variable dependencies.
