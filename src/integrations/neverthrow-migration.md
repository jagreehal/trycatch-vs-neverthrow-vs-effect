# Migrating from neverthrow to Awaitly

A gradual migration guide for teams already using neverthrow who want to adopt Awaitly's workflows, automatic error inference, and additional features.

## Why Migrate?

**Keep what you love about neverthrow:**
- Type-safe Result types
- Explicit error handling
- Railway-oriented programming

**Add what Awaitly provides:**
- **Automatic error type inference**: No more manual union types
- **Async/await syntax**: Familiar imperative style with `step()`
- **Built-in workflows**: Caching, resume state, HITL
- **Policies and resilience**: Retries, timeouts, circuit breakers
- **Streaming**: Result-aware stream processing
- **Functional utilities**: `pipe`, `flow`, `R.*` helpers

## Quick Comparison

```typescript
// neverthrow
import { ok, err, ResultAsync } from 'neverthrow';

const fetchUser = (id: string): ResultAsync<User, 'NOT_FOUND' | 'FETCH_ERROR'> =>
  ResultAsync.fromPromise(
    api.getUser(id),
    () => 'FETCH_ERROR'
  ).andThen(user =>
    user ? ok(user) : err('NOT_FOUND')
  );

// Usage: Method chaining
const result = await fetchUser('1')
  .andThen(user => fetchPosts(user.id))
  .map(posts => posts.length);

// awaitly
import { ok, err, type AsyncResult } from 'awaitly';
import { run } from 'awaitly/run';

const fetchUser = async (id: string): AsyncResult<User, 'NOT_FOUND' | 'FETCH_ERROR'> => {
  try {
    const user = await api.getUser(id);
    return user ? ok(user) : err('NOT_FOUND');
  } catch {
    return err('FETCH_ERROR');
  }
};

// Usage: Async/await with step()
const result = await run(async ({ step }) => {
  const user = await step('getUser', () => fetchUser('1'));
  const posts = await step('getPosts', () => fetchPosts(user.id));
  return posts.length;
}, { onError: () => {} });
```

## Side-by-Side API Comparison

| neverthrow | Awaitly | Notes |
| :--- | :--- | :--- |
| `ok(value)` | `ok(value)` | Identical |
| `err(error)` | `err(error)` | Identical |
| `Result<T, E>` | `Result<T, E>` | Identical structure |
| `ResultAsync<T, E>` | `AsyncResult<T, E>` | Type alias for `Promise<Result<T, E>>` |
| `.isOk()` / `.isErr()` | `result.ok` | Boolean property |
| `.value` / `.error` | `result.value` / `result.error` | Direct access when `ok` is checked |
| `.andThen(fn)` | `await step('id', () => fn(value))` | In workflows |
| `.map(fn)` | `R.map(fn)` | Via functional utilities |
| `.mapErr(fn)` | `R.mapError(fn)` | Via functional utilities |
| `.orElse(fn)` | Manual check or `match()` | More explicit |
| `ResultAsync.combine([])` | `allAsync([])` | Parallel execution |
| `ResultAsync.fromPromise()` | `step.try()` | Wrap throwing code |
| N/A | `createWorkflow()` | Auto error inference |
| N/A | `step.retry()` | Built-in retries |
| N/A | `createSagaWorkflow()` | Compensation/rollback |

## Migration Strategies

### Strategy 1: Parallel Adoption (Recommended)

Keep neverthrow in existing code, use Awaitly in new modules:

```typescript
// Existing code: Keep neverthrow (no changes needed)
// src/legacy/user-service.ts
import { ok, err, ResultAsync } from 'neverthrow';

export const getUser = (id: string): ResultAsync<User, 'NOT_FOUND'> =>
  ResultAsync.fromPromise(db.findUser(id), () => 'NOT_FOUND');

// New code: Use Awaitly
// src/features/checkout/workflow.ts
import { createWorkflow } from 'awaitly/workflow';
import { getUser } from '@/legacy/user-service'; // Import neverthrow function

// Interop helper
const fromNeverthrow = async <T, E>(
  result: ResultAsync<T, E>
): AsyncResult<T, E> => {
  const r = await result;
  return r.isOk() ? ok(r.value) : err(r.error);
};

// New workflow using both
const checkoutWorkflow = createWorkflow('checkout', {
  validateCart,
  processPayment,
});

const result = await checkoutWorkflow(async ({ step, deps }) => {
  // Use legacy neverthrow function via interop
  const user = await step('getUser', () => fromNeverthrow(getUser(userId)));

  // Use new Awaitly functions
  const cart = await step('validateCart', () => deps.validateCart(user.id));
  const payment = await step('processPayment', () => deps.processPayment(cart));

  return { orderId: payment.id };
});
```

### Strategy 2: Function-by-Function Migration

Convert individual functions when you touch them:

```typescript
// Before: neverthrow
import { ok, err, ResultAsync } from 'neverthrow';

const validateEmail = (email: string): Result<string, 'INVALID_EMAIL'> =>
  email.includes('@') ? ok(email) : err('INVALID_EMAIL');

const createUser = (data: UserInput): ResultAsync<User, CreateUserError> =>
  validateEmail(data.email)
    .asyncAndThen(email =>
      ResultAsync.fromPromise(
        db.createUser({ ...data, email }),
        () => 'DB_ERROR'
      )
    );

// After: Awaitly
import { ok, err, type AsyncResult } from 'awaitly';
import { run } from 'awaitly/run';

const validateEmail = (email: string): Result<string, 'INVALID_EMAIL'> =>
  email.includes('@') ? ok(email) : err('INVALID_EMAIL');

const createUser = async (data: UserInput): AsyncResult<User, 'INVALID_EMAIL' | 'DB_ERROR'> =>
  run(async ({ step }) => {
    const email = await step('validateEmail', () => validateEmail(data.email));

    const user = await step.try(
      'createUser',
      () => db.createUser({ ...data, email }),
      { error: 'DB_ERROR' as const }
    );

    return user;
  }, { onError: () => {} });
```

### Strategy 3: Module-by-Module Rewrite

When refactoring a module, convert the entire module to Awaitly:

```typescript
// Before: src/services/payment.ts (neverthrow)
import { ok, err, ResultAsync } from 'neverthrow';

export const validatePayment = (data: unknown): Result<PaymentInput, ValidationError> => { ... };
export const chargeCard = (input: PaymentInput): ResultAsync<ChargeResult, ChargeError> => { ... };
export const recordTransaction = (charge: ChargeResult): ResultAsync<Transaction, DbError> => { ... };

export const processPayment = (data: unknown): ResultAsync<Transaction, ProcessPaymentError> =>
  validatePayment(data)
    .asyncAndThen(chargeCard)
    .andThen(recordTransaction);

// After: src/services/payment.ts (Awaitly)
import { ok, err, type AsyncResult } from 'awaitly';
import { createWorkflow } from 'awaitly/workflow';

export const validatePayment = (data: unknown): Result<PaymentInput, ValidationError> => { ... };
export const chargeCard = async (input: PaymentInput): AsyncResult<ChargeResult, ChargeError> => { ... };
export const recordTransaction = async (charge: ChargeResult): AsyncResult<Transaction, DbError> => { ... };

// Error type automatically inferred!
export const processPayment = createWorkflow('processPayment', {
  validatePayment,
  chargeCard,
  recordTransaction,
});

// Usage
const result = await processPayment(async ({ step, deps }) => {
  const input = await step('validatePayment', () => deps.validatePayment(data));
  const charge = await step('chargeCard', () => deps.chargeCard(input));
  const transaction = await step('recordTransaction', () => deps.recordTransaction(charge));
  return transaction;
});
// result.error type: ValidationError | ChargeError | DbError | UnexpectedError
```

## Interop Utilities

Copy these helpers to your project for seamless interop:

```typescript
// src/lib/neverthrow-interop.ts
import { Result as NtResult, ResultAsync as NtResultAsync, ok as ntOk, err as ntErr } from 'neverthrow';
import { ok, err, type Result, type AsyncResult } from 'awaitly';

/**
 * Convert neverthrow Result to Awaitly Result
 */
export const fromNeverthrowResult = <T, E>(result: NtResult<T, E>): Result<T, E> =>
  result.isOk() ? ok(result.value) : err(result.error);

/**
 * Convert neverthrow ResultAsync to Awaitly AsyncResult
 */
export const fromNeverthrow = async <T, E>(
  result: NtResultAsync<T, E>
): AsyncResult<T, E> => {
  const r = await result;
  return r.isOk() ? ok(r.value) : err(r.error);
};

/**
 * Convert Awaitly Result to neverthrow Result
 */
export const toNeverthrowResult = <T, E>(result: Result<T, E>): NtResult<T, E> =>
  result.ok ? ntOk(result.value) : ntErr(result.error);

/**
 * Convert Awaitly AsyncResult to neverthrow ResultAsync
 */
export const toNeverthrow = <T, E>(
  result: AsyncResult<T, E>
): NtResultAsync<T, E> =>
  NtResultAsync.fromPromise(
    result.then(r => {
      if (!r.ok) throw r.error;
      return r.value;
    }),
    (e) => e as E
  );

/**
 * Wrap a neverthrow function for use in Awaitly workflows
 */
export const wrapNeverthrow = <Args extends unknown[], T, E>(
  fn: (...args: Args) => NtResultAsync<T, E>
) => async (...args: Args): AsyncResult<T, E> => {
  return fromNeverthrow(fn(...args));
};
```

Usage in workflows:

```typescript
import { fromNeverthrow, wrapNeverthrow } from '@/lib/neverthrow-interop';
import { legacyFetchUser } from '@/legacy/user-service'; // neverthrow function

// Option 1: Inline conversion
const user = await step('getUser', () => fromNeverthrow(legacyFetchUser(id)));

// Option 2: Pre-wrap the function
const fetchUser = wrapNeverthrow(legacyFetchUser);
const user = await step('getUser', () => fetchUser(id));
```

## When to Keep neverthrow

Don't migrate everything! Keep neverthrow when:

1. **The code is stable and working**: "If it ain't broke, don't fix it"
2. **You prefer method chaining**: Some teams find `.andThen().map()` more readable
3. **You don't need workflows**: Simple Result functions don't benefit from `createWorkflow`
4. **Library code**: Consumers might expect neverthrow types

## Migration Checklist

### Phase 1: Setup (Day 1)
- [ ] Install awaitly: `npm install awaitly`
- [ ] Create interop utilities file
- [ ] Identify one new feature to build with Awaitly

### Phase 2: Parallel Usage (Weeks 1-4)
- [ ] Build new features with Awaitly
- [ ] Use interop helpers when calling neverthrow functions
- [ ] Document patterns that work well

### Phase 3: Gradual Migration (Ongoing)
- [ ] When touching existing neverthrow code, consider converting
- [ ] Prioritize modules that benefit from workflows, retries, or caching
- [ ] Keep stable, working neverthrow code as-is

### Phase 4: Cleanup (Optional)
- [ ] Remove neverthrow from modules that are fully migrated
- [ ] Remove interop utilities when no longer needed
- [ ] Consider removing neverthrow dependency entirely

## Common Patterns Migration

### Chained Operations

```typescript
// neverthrow
fetchUser(id)
  .andThen(user => fetchPosts(user.id))
  .andThen(posts => enrichPosts(posts))
  .map(posts => posts.filter(p => p.published))
  .mapErr(e => new ApiError(e));

// awaitly
await run(async ({ step }) => {
  const user = await step('getUser', () => fetchUser(id));
  const posts = await step('getPosts', () => fetchPosts(user.id));
  const enriched = await step('enrichPosts', () => enrichPosts(posts));
  return enriched.filter(p => p.published);
}, {
  onError: (e) => new ApiError(e)
});
```

### Error Recovery

```typescript
// neverthrow
fetchUser(id)
  .orElse(error =>
    error === 'NOT_FOUND'
      ? ok(defaultUser)
      : err(error)
  );

// awaitly
const userResult = await fetchUser(id);
const user = !userResult.ok && userResult.error === 'NOT_FOUND'
  ? defaultUser
  : await step('getUser', () => userResult);
```

### Parallel Execution

```typescript
// neverthrow
ResultAsync.combine([
  fetchUser(userId),
  fetchPosts(userId),
  fetchComments(userId),
]);

// awaitly (name first, then operations object)
await step.parallel('Fetch user data', {
  user: () => fetchUser(userId),
  posts: () => fetchPosts(userId),
  comments: () => fetchComments(userId),
});

// Or for dynamic arrays:
await step.fromResult(
  () => allAsync(ids.map(id => fetchUser(id))),
  { onError: (e) => e }
);
```

### Wrapping Throwing Code

```typescript
// neverthrow
ResultAsync.fromPromise(
  riskyOperation(),
  (e) => new CustomError(String(e))
);

// awaitly
await step.try(
  () => riskyOperation(),
  { onError: (e) => new CustomError(String(e)) }
);
```

## Tips

1. **Start with new code**: Don't rush to rewrite working neverthrow code
2. **Use interop freely**: The helpers have minimal overhead
3. **Leverage workflows**: The real value of Awaitly is in `createWorkflow` for complex flows
4. **Keep types explicit during migration**: Add return types to catch interop issues early
5. **Test thoroughly**: Both libraries have the same Result semantics, but subtle bugs can creep in
