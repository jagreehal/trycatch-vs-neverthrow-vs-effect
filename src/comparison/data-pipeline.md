# Real-World Scenario: Data Pipeline with Caching & Resume

**Scenario:** A data pipeline that fetches a User, then their Posts, then Comments for those posts, and finally processes Analytics.
**Key Constraints:** APIs are slow (need caching) and processes may be interrupted (need resume capability).

See the code: `data-pipeline.test.ts`

## The Approaches

### 1. The awaitly Approach
*High readability, built-in caching and resume.*

awaitly excels here because caching and resume state are first-class features. You don't need to wrap your logic in external helper functions; you just configure the step with a `key`.

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

## Comparison Table

| Feature | awaitly | Neverthrow | Effect |
| :--- | :--- | :--- | :--- |
| **Caching** | Built-in (`key` param) | Manual implementation | Via Request Cache service / manual wiring |
| **Resume State** | Built-in (`resumeState`) | Manual implementation | Manual implementation |
| **Observability** | Built-in (`onEvent`) | Manual implementation | Runtime tracing / logging (needs configuration) |
| **Parallelism** | `allAsync()` | `ResultAsync.combine()` | `Effect.all()` |
| **Syntax** | Async/Await | Method Chaining | Generator (`yield*`) |
| **Readability** | High | Medium (Nesting) | High (Once learned) |

## Conclusion

For **Data Pipelines**:
- **Effect** is the most robust choice if you need complex policies (circuit breakers, rate limiting, retries) and are willing to wire the runtime services you need.
- **awaitly** is the pragmatic choice. It gives you caching, resume state, and observability with zero boilerplate and familiar syntax.
- **Neverthrow** struggles here without extra utility libraries for caching and resume functionality.
