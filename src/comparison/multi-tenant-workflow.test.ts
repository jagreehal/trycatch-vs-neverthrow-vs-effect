/**
 * Real-World Scenario: Multi-Tenant Workflow with Conditional Logic
 * 
 * This scenario demonstrates:
 * - Decision tracking (if/switch statements)
 * - Parallel operations with different tenants
 * - Error handling per tenant
 * - Visualization of complex conditional flows
 * 
 * Compare implementations across workflow, neverthrow, and effect.
 */

import { describe, it, expect } from 'vitest';
import { ResultAsync, okAsync } from 'neverthrow';
import { Effect } from 'effect';
import { ok, err, allAsync, type AsyncResult } from '@jagreehal/workflow';
import { createWorkflow } from '@jagreehal/workflow';

// ============================================================================
// Shared Types
// ============================================================================

type TenantId = string;
type Tenant = {
  id: TenantId;
  name: string;
  plan: 'free' | 'pro' | 'enterprise';
  features: string[];
};
type User = { id: string; tenantId: TenantId; email: string; role: 'admin' | 'user' };
type Resource = { id: string; tenantId: TenantId; name: string; type: 'storage' | 'compute' };
type Usage = { tenantId: TenantId; resources: number; cost: number };

type TenantError = 'TENANT_NOT_FOUND' | 'TENANT_SUSPENDED';
type UserError = 'USER_NOT_FOUND' | 'PERMISSION_DENIED';
type ResourceError = 'RESOURCE_LIMIT_EXCEEDED' | 'RESOURCE_FETCH_FAILED';
type UsageError = 'USAGE_CALCULATION_FAILED';

type MultiTenantError = TenantError | UserError | ResourceError | UsageError;

// ============================================================================
// Shared Dependencies
// ============================================================================

const fetchTenantImpl = async (tenantId: TenantId): Promise<Tenant> => {
  await new Promise(resolve => setTimeout(resolve, 20));
  
  if (tenantId === 'missing') {
    throw new Error('TENANT_NOT_FOUND');
  }
  
  const plans: Record<string, { plan: Tenant['plan']; features: string[] }> = {
    'tenant-1': { plan: 'free', features: ['basic'] },
    'tenant-2': { plan: 'pro', features: ['basic', 'advanced'] },
    'tenant-3': { plan: 'enterprise', features: ['basic', 'advanced', 'premium'] },
    'limit-exceeded': { plan: 'pro', features: ['basic', 'advanced'] },
  };
  
  const config = plans[tenantId] || { plan: 'free' as const, features: ['basic'] };
  
  return {
    id: tenantId,
    name: `Tenant ${tenantId}`,
    plan: config.plan,
    features: config.features,
  };
};

const fetchUsersImpl = async (tenantId: TenantId): Promise<User[]> => {
  await new Promise(resolve => setTimeout(resolve, 30));
  
  return [
    { id: 'user-1', tenantId, email: 'user1@example.com', role: 'admin' },
    { id: 'user-2', tenantId, email: 'user2@example.com', role: 'user' },
  ];
};

const fetchResourcesImpl = async (tenantId: TenantId): Promise<Resource[]> => {
  await new Promise(resolve => setTimeout(resolve, 40));
  
  if (tenantId === 'limit-exceeded') {
    throw new Error('RESOURCE_LIMIT_EXCEEDED');
  }
  
  return [
    { id: 'res-1', tenantId, name: 'Storage 1', type: 'storage' },
    { id: 'res-2', tenantId, name: 'Compute 1', type: 'compute' },
  ];
};

const calculateUsageImpl = async (
  tenant: Tenant,
  users: User[],
  resources: Resource[]
): Promise<Usage> => {
  await new Promise(resolve => setTimeout(resolve, 25));
  
  let cost = 0;
  
  if (tenant.plan === 'free') {
    cost = 0;
  } else if (tenant.plan === 'pro') {
    cost = users.length * 10 + resources.length * 5;
  } else if (tenant.plan === 'enterprise') {
    cost = users.length * 20 + resources.length * 10;
  }
  
  return {
    tenantId: tenant.id,
    resources: resources.length,
    cost,
  };
};

const sendBillingNotificationImpl = async (
  tenant: Tenant,
  usage: Usage
): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 15));
};

// ============================================================================
// Workflow Implementation
// ============================================================================

const fetchTenant = async (tenantId: TenantId): AsyncResult<Tenant, TenantError> => {
  try {
    const tenant = await fetchTenantImpl(tenantId);
    return ok(tenant);
  } catch (e: any) {
    return err(e.message as TenantError);
  }
};

const fetchUsers = async (tenantId: TenantId): AsyncResult<User[], UserError> => {
  try {
    const users = await fetchUsersImpl(tenantId);
    return ok(users);
  } catch {
    return err('USER_NOT_FOUND');
  }
};

const fetchResources = async (tenantId: TenantId): AsyncResult<Resource[], ResourceError> => {
  try {
    const resources = await fetchResourcesImpl(tenantId);
    return ok(resources);
  } catch (e: any) {
    return err(e.message as ResourceError);
  }
};

const calculateUsage = async (
  tenant: Tenant,
  users: User[],
  resources: Resource[]
): AsyncResult<Usage, UsageError> => {
  try {
    const usage = await calculateUsageImpl(tenant, users, resources);
    return ok(usage);
  } catch {
    return err('USAGE_CALCULATION_FAILED');
  }
};

const sendBillingNotification = async (
  tenant: Tenant,
  usage: Usage
): AsyncResult<void, 'NOTIFICATION_FAILED'> => {
  try {
    await sendBillingNotificationImpl(tenant, usage);
    return ok(undefined);
  } catch {
    return err('NOTIFICATION_FAILED');
  }
};

export async function multiTenantWorkflow(
  tenantId: TenantId
): AsyncResult<Usage, MultiTenantError> {
  const deps = {
    fetchTenant: () => fetchTenant(tenantId),
    fetchUsers: () => fetchUsers(tenantId),
    fetchResources: () => fetchResources(tenantId),
    calculateUsage: (tenant: Tenant, users: User[], resources: Resource[]) =>
      calculateUsage(tenant, users, resources),
    sendBillingNotification: (tenant: Tenant, usage: Usage) =>
      sendBillingNotification(tenant, usage),
  };

  const workflow = createWorkflow(deps);

  return workflow(async (step, deps) => {
    const tenant = await step(() => deps.fetchTenant(), {
      name: 'Fetch tenant',
      key: `tenant:${tenantId}`,
    });

    if (tenant.plan !== 'free') {
      const [users, resources] = await step(
        () => allAsync([
          deps.fetchUsers(),
          deps.fetchResources(),
        ]),
        {
          name: 'Fetch tenant data',
          key: `tenant-data:${tenantId}`,
        }
      );

      const usage = await step(
        () => deps.calculateUsage(tenant, users, resources),
        {
          name: 'Calculate usage',
          key: `usage:${tenantId}`,
        }
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
        default:
          // Free plan: no notification
      }

      return usage;
    } else {
      const usage = await step(
        () => deps.calculateUsage(tenant, [], []),
        {
          name: 'Calculate usage (free plan)',
          key: `usage:${tenantId}:free`,
        }
      );
      
      return usage;
    }
  });
}

// ============================================================================
// Neverthrow Implementation
// ============================================================================

const fetchTenantNt = (tenantId: TenantId): ResultAsync<Tenant, TenantError> =>
  ResultAsync.fromPromise(
    fetchTenantImpl(tenantId),
    (e: any) => e.message as TenantError
  );

const fetchUsersNt = (tenantId: TenantId): ResultAsync<User[], UserError> =>
  ResultAsync.fromPromise(
    fetchUsersImpl(tenantId),
    () => 'USER_NOT_FOUND' as const
  );

const fetchResourcesNt = (tenantId: TenantId): ResultAsync<Resource[], ResourceError> =>
  ResultAsync.fromPromise(
    fetchResourcesImpl(tenantId),
    (e: any) => e.message as ResourceError
  );

const calculateUsageNt = (
  tenant: Tenant,
  users: User[],
  resources: Resource[]
): ResultAsync<Usage, UsageError> =>
  ResultAsync.fromPromise(
    calculateUsageImpl(tenant, users, resources),
    () => 'USAGE_CALCULATION_FAILED' as const
  );

const sendBillingNotificationNt = (
  tenant: Tenant,
  usage: Usage
): ResultAsync<void, 'NOTIFICATION_FAILED'> =>
  ResultAsync.fromPromise(
    sendBillingNotificationImpl(tenant, usage),
    () => 'NOTIFICATION_FAILED' as const
  );

export function multiTenantNeverthrow(
  tenantId: TenantId
): ResultAsync<Usage, MultiTenantError> {
  return fetchTenantNt(tenantId).andThen((tenant) => {
    if (tenant.plan === 'free') {
      return calculateUsageNt(tenant, [], []);
    }

    return ResultAsync.combine([
      fetchUsersNt(tenantId),
      fetchResourcesNt(tenantId),
    ]).andThen(([users, resources]) =>
      calculateUsageNt(tenant, users, resources).andThen((usage) => {
        if (tenant.plan === 'pro' || tenant.plan === 'enterprise') {
          return sendBillingNotificationNt(tenant, usage).map(() => usage);
        }
        return okAsync(usage);
      })
    );
  });
}

// ============================================================================
// Effect Implementation
// ============================================================================

const fetchTenantEffect = (tenantId: TenantId): Effect.Effect<Tenant, TenantError> =>
  Effect.tryPromise({
    try: () => fetchTenantImpl(tenantId),
    catch: (e: any) => e.message as TenantError,
  });

const fetchUsersEffect = (tenantId: TenantId): Effect.Effect<User[], UserError> =>
  Effect.tryPromise({
    try: () => fetchUsersImpl(tenantId),
    catch: () => 'USER_NOT_FOUND' as const,
  });

const fetchResourcesEffect = (tenantId: TenantId): Effect.Effect<Resource[], ResourceError> =>
  Effect.tryPromise({
    try: () => fetchResourcesImpl(tenantId),
    catch: (e: any) => e.message as ResourceError,
  });

const calculateUsageEffect = (
  tenant: Tenant,
  users: User[],
  resources: Resource[]
): Effect.Effect<Usage, UsageError> =>
  Effect.tryPromise({
    try: () => calculateUsageImpl(tenant, users, resources),
    catch: () => 'USAGE_CALCULATION_FAILED' as const,
  });

const sendBillingNotificationEffect = (
  tenant: Tenant,
  usage: Usage
): Effect.Effect<void, 'NOTIFICATION_FAILED'> =>
  Effect.tryPromise({
    try: () => sendBillingNotificationImpl(tenant, usage),
    catch: () => 'NOTIFICATION_FAILED' as const,
  });

export const multiTenantEffect = (tenantId: TenantId): Effect.Effect<Usage, MultiTenantError> =>
  Effect.gen(function* () {
    const tenant = yield* fetchTenantEffect(tenantId);

    if (tenant.plan === 'free') {
      return yield* calculateUsageEffect(tenant, [], []);
    }

    const [users, resources] = yield* Effect.all([
      fetchUsersEffect(tenantId),
      fetchResourcesEffect(tenantId),
    ], { concurrency: 'unbounded' });

    const usage = yield* calculateUsageEffect(tenant, users, resources);

    if (tenant.plan === 'pro' || tenant.plan === 'enterprise') {
      yield* sendBillingNotificationEffect(tenant, usage);
    }

    return usage;
  });

// ============================================================================
// Tests
// ============================================================================

describe('Multi-Tenant Workflow', () => {
  describe('Workflow', () => {
    it('processes pro tenant with full workflow', async () => {
      const result = await multiTenantWorkflow('tenant-2');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe('tenant-2');
        expect(result.value.cost).toBeGreaterThan(0);
      }
    });

    it('processes free tenant with minimal workflow', async () => {
      const result = await multiTenantWorkflow('tenant-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe('tenant-1');
        expect(result.value.cost).toBe(0);
      }
    });

    it('processes enterprise tenant with premium features', async () => {
      const result = await multiTenantWorkflow('tenant-3');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tenantId).toBe('tenant-3');
        expect(result.value.cost).toBeGreaterThan(0);
      }
    });

    it('fails on missing tenant', async () => {
      const result = await multiTenantWorkflow('missing');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('TENANT_NOT_FOUND');
      }
    });

    it('fails on resource limit exceeded', async () => {
      const result = await multiTenantWorkflow('limit-exceeded');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('RESOURCE_LIMIT_EXCEEDED');
      }
    });
  });

  describe('Neverthrow', () => {
    it('processes pro tenant with full workflow', async () => {
      const result = await multiTenantNeverthrow('tenant-2');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.tenantId).toBe('tenant-2');
        expect(result.value.cost).toBeGreaterThan(0);
      }
    });

    it('processes free tenant with minimal workflow', async () => {
      const result = await multiTenantNeverthrow('tenant-1');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.tenantId).toBe('tenant-1');
        expect(result.value.cost).toBe(0);
      }
    });

    it('processes enterprise tenant with premium features', async () => {
      const result = await multiTenantNeverthrow('tenant-3');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.tenantId).toBe('tenant-3');
        expect(result.value.cost).toBeGreaterThan(0);
      }
    });

    it('fails on missing tenant', async () => {
      const result = await multiTenantNeverthrow('missing');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe('TENANT_NOT_FOUND');
      }
    });

    it('fails on resource limit exceeded', async () => {
      const result = await multiTenantNeverthrow('limit-exceeded');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBe('RESOURCE_LIMIT_EXCEEDED');
      }
    });
  });

  describe('Effect', () => {
    it('processes pro tenant with full workflow', async () => {
      const result = await Effect.runPromise(multiTenantEffect('tenant-2'));

      expect(result.tenantId).toBe('tenant-2');
      expect(result.cost).toBeGreaterThan(0);
    });

    it('processes free tenant with minimal workflow', async () => {
      const result = await Effect.runPromise(multiTenantEffect('tenant-1'));

      expect(result.tenantId).toBe('tenant-1');
      expect(result.cost).toBe(0);
    });

    it('processes enterprise tenant with premium features', async () => {
      const result = await Effect.runPromise(multiTenantEffect('tenant-3'));

      expect(result.tenantId).toBe('tenant-3');
      expect(result.cost).toBeGreaterThan(0);
    });

    it('fails on missing tenant', async () => {
      const exit = await Effect.runPromiseExit(multiTenantEffect('missing'));

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBe('TENANT_NOT_FOUND');
      }
    });

    it('fails on resource limit exceeded', async () => {
      const exit = await Effect.runPromiseExit(multiTenantEffect('limit-exceeded'));

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBe('RESOURCE_LIMIT_EXCEEDED');
      }
    });
  });
});
