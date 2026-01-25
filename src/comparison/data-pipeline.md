# Real-World Scenario: Data Pipeline with Caching & Resume

**Scenario:** A data pipeline that fetches a User, then their Posts, then Comments for those posts, and finally processes Analytics.
**Key Constraints:** APIs are slow (need caching) and processes may be interrupted (need resume capability).

See the code: `data-pipeline.test.ts`

## The Approaches

### 1. The Awaitly Approach
*High readability, built-in caching and resume.*

Awaitly excels here because caching and resume state are first-class features. You don't need to wrap your logic in external helper functions; you just configure the step with a `key`.

```typescript
// Built-in caching and resume
return workflow(async (step, deps) => {
  const user = await step(
    () => deps.fetchUser(userId),
    {
      name: 'Fetch user',
      key: `user:${userId}`, // Enables caching & resume
    }
  );
});
```

**Pros:**
- **Caching:** The `key` parameter automatically handles idempotency and caching, avoiding duplicate API calls.
- **Resume:** Can pause and resume the pipeline from the last successful step (using `resumeState`).
- **Observability:** `onEvent` hook lets you trace the entire execution with step-by-step events.
- **Automatic Error Inference:** TypeScript automatically infers the union of all possible errors (plus the standard `UnexpectedError` safety net unless you opt into strict mode).

**Cons:**
- Requires the `createWorkflow` wrapper (from `awaitly/workflow`) to get the full power of caching/inference.

### 2. The Neverthrow Approach
*Explicit, but requires manual helpers.*

Neverthrow handles the happy path cleanly with chains, but doesn't have built-in retry or caching logic for promises. You often end up writing custom helpers or using raw `try/catch` loops inside your Result chains.

```typescript
return fetchUserNt(userId).andThen((user) =>
  fetchPostsNt(userId).andThen((posts) =>
    // ... nesting grows deeper ...
  )
);
```

**Pros:**
- **Explicit Data Flow:** Very clear what data is passed where.
- **No Magic:** It's just functions calling functions.

**Cons:**
- **No Native Caching:** You have to manually check a cache before calling the function.
- **No Resume State:** You have to manually implement checkpoint/resume logic.
- **Nesting:** As the pipeline grows (User -> Posts -> Comments -> Analytics), the indentation drift ("callback hell") can get real.

### 3. The Effect Approach
*Powerful policies, steep learning curve.*

Effect is designed for this. It treats retries, timeouts, and concurrency limits as reusable policies that you compose around your effects. In the tests we wrap the comment/post fetchers with `Effect.timeoutFail` + `Effect.retry` driven by an exponential `Schedule`, then join them via `Effect.all`.

**Pros:**
- **Policy Composition:** Retries, timeouts, and rate limits are trivial to add (`Effect.retry`, `Effect.timeoutFail`).
- **Concurrency:** `Effect.all(..., { concurrency: 'unbounded' })` makes parallel fetching (like comments for all posts) straightforward and cancels losers on failure.
- **Request Caching:** Effect ships a request cache service if you need deduping.

**Cons:**
- **Complexity:** Requires understanding `Effect`, `Schedule`, `yield*`, and `pipe`.
- **Resume State:** Resume functionality would require custom implementation.
- **Overkill:** Might be too much "machinery" for a simple script.

### 4. Awaitly Advanced Features

Awaitly now provides the same production-grade reliability features as Effect, with familiar syntax:

```typescript
import { durable } from 'awaitly/durable';
import { createCircuitBreaker, circuitBreakerPresets } from 'awaitly/circuit-breaker';
import { createRateLimiter } from 'awaitly/ratelimit';
import { servicePolicies, withPolicy } from 'awaitly/policies';

// Circuit breaker for flaky APIs
const apiBreaker = createCircuitBreaker('external-api', circuitBreakerPresets.standard);

// Rate limiting for external services
const rateLimiter = createRateLimiter('api', { maxPerSecond: 10 });

// Durable execution with automatic resume
const result = await durable.run(
  { fetchUser, fetchPosts, fetchComments },
  async (step, deps) => {
    const user = await step(
      () => deps.fetchUser(userId),
      withPolicy(servicePolicies.httpApi, { key: `user:${userId}` })
    );

    // Rate-limited + circuit-protected API call
    const posts = await rateLimiter.execute(() =>
      apiBreaker.executeResult(() =>
        step(() => deps.fetchPosts(user.id), { key: `posts:${user.id}` })
      )
    );

    return { user, posts };
  },
  { id: `pipeline-${userId}`, store, version: 1 }
);
```

**Pros:**
- **Built-in Policies:** `servicePolicies.httpApi`, `retryPolicies`, `timeoutPolicies`
- **Circuit Breakers:** `createCircuitBreaker` with presets (critical/standard/lenient)
- **Rate Limiting:** `createRateLimiter`, `createConcurrencyLimiter`
- **Durable Execution:** `durable.run` with automatic checkpointing and resume
- **Familiar Syntax:** Still async/await, no new paradigm to learn

## Comparison Table

| Feature | Awaitly | Neverthrow | Effect |
| :--- | :--- | :--- | :--- |
| **Caching** | Built-in (`key` param) | Manual implementation | Via Request Cache service |
| **Resume State** | Built-in (`resumeState`, `durable.run`) | Manual implementation | Manual implementation |
| **Observability** | Built-in (`onEvent`) | Manual implementation | Runtime tracing / logging |
| **Circuit Breaker** | Built-in (`createCircuitBreaker`) | Manual implementation | Manual implementation |
| **Rate Limiting** | Built-in (`createRateLimiter`) | Manual implementation | Manual implementation |
| **Policies** | Built-in (`servicePolicies`) | Manual implementation | Via `Schedule` |
| **Parallelism** | `allAsync()`, `step.parallel()` | `ResultAsync.combine()` | `Effect.all()` |
| **Syntax** | Async/Await | Method Chaining | Generator (`yield*`) |
| **Readability** | High | Medium (Nesting) | High (Once learned) |

## Conclusion

For **Data Pipelines**:
- **Awaitly** now matches Effect's feature set for reliability (circuit breakers, rate limiting, policies, durable execution) while maintaining familiar async/await syntax. It's the best choice for teams that want production-grade reliability without learning a new paradigm.
- **Effect** remains powerful if you need structured concurrency with fiber semantics and are comfortable with functional programming.
- **Neverthrow** struggles here without extra utility libraries for caching, resume, and reliability features.
