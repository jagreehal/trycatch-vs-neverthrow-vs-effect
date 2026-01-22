# Real-World Scenario: Multi-Tenant Workflow

**Scenario:** A SaaS workflow that behaves differently based on the Tenant's Plan (Free vs Pro vs Enterprise).
**Key Constraints:** Conditional logic (if/else/switch), branching paths.

See the code: `multi-tenant-workflow.test.ts`

## The Approaches

### 1. The awaitly Approach
*Just JavaScript.*

Since awaitly uses standard `async/await`, you can use standard JavaScript control flow statements like `if`, `else`, and `switch`.

```typescript
// It's just standard code!
return workflow(async (step, deps) => {
  const tenant = await step(() => deps.fetchTenant(tenantId), {
    name: 'Fetch tenant',
    key: `tenant:${tenantId}`,
  });

if (tenant.plan === 'free') {
  return await step(
    () => deps.calculateUsage(tenant, [], []),
    { name: 'Calculate usage (free plan)', key: `usage:${tenantId}:free` }
  );
} else {
  const { users, resources } = await step.parallel(
    {
      users: () => deps.fetchUsers(tenantId),
      resources: () => deps.fetchResources(tenantId),
    },
    { name: 'Fetch tenant data' }
  );
  
  const usage = await step(
    () => deps.calculateUsage(tenant, users, resources),
    { name: 'Calculate usage', key: `usage:${tenantId}` }
  );
  
  switch (tenant.plan) {
    case 'pro':
      await step(() => deps.sendBillingNotification(tenant, usage), {
        name: 'Send pro billing notification',
        key: `notify:${tenantId}:pro`,
      });
      break;
    case 'enterprise':
      await step(() => deps.sendBillingNotification(tenant, usage), {
        name: 'Send enterprise billing notification',
        key: `notify:${tenantId}:enterprise`,
      });
      break;
  }
  
  return usage;
});
```

**Pros:**
- **Zero Friction:** No need to learn "functional" equivalents of `if` statements.
- **Readability:** Junior devs understand this immediately.

### 2. The Neverthrow Approach
*Functional Conditionals.*

Neverthrow doesn't have "statements". Everything is an expression. This makes branching logic awkward. You often have to return `Result`s from inside `map` or `andThen`, leading to return type mismatches that are hard to fix.

```typescript
return fetchTenant(id).andThen(tenant => {
  if (tenant.plan === 'free') {
    return calculateFreeUsage(); // Must return same Result type!
  }
  // If 'Pro' returns a different success type, you have to normalize it.
});
```

**Pros:**
- **Expressions:** Forces you to treat code as expressions (value-oriented).

**Cons:**
- **Awkward Branching:** `if/else` inside chains often feels clunky.
- **Type Mismatches:** All branches must return compatible `Result` types, which can be annoying to align manually.

### 3. The Effect Approach
*Generators save the day.*

Like Workflow, Effect uses generators (`yield*`), which allows using standard `if/switch` statements.

```typescript
Effect.gen(function* () {
  const tenant = yield* fetchTenant(id);
  if (tenant.plan === 'free') {
    // ...
  }
});
```

**Pros:**
- **Flexible:** Combines the power of functional programming with imperative control flow syntax.

**Cons:**
- **Setup:** Still requires the Effect boilerplate (`Effect.gen`, `runPromise`, etc.).

## Comparison Table

| Feature | awaitly | Neverthrow | Effect |
| :--- | :--- | :--- | :--- |
| **Control Flow** | Native (`if`/`switch`) | Functional (`match` / conditionals inside `map`) | Native (`if`/`switch` in gen) |
| **Branch Typing** | Automatic Union | Manual Alignment | Automatic Union |
| **Readability** | High | Low (for complex branches) | High |

## Conclusion

For **Logic with Branching (Multi-Tenant)**:
- **awaitly** and **Effect** both offer excellent DX because they allow imperative control flow (`if/else`) while maintaining type safety.
- **Neverthrow** can be cumbersome here. Functional pipelines are great for linear sequences but struggle with complex branching logic unless you break them into many small helper functions.
