# Using Prisma with Awaitly

Turn Prisma database errors into typed Results for exhaustive error handling.

## Why Combine Them?

- **Exhaustive error handling**: Handle `NOT_FOUND`, `UNIQUE_VIOLATION`, etc. explicitly
- **No more try/catch spaghetti**: Database operations compose cleanly in workflows
- **Type-safe error codes**: Prisma's error codes become typed union members

## Quick Start

```typescript
import { Prisma } from '@prisma/client';
import { ok, err, type AsyncResult } from 'awaitly';
import { run } from 'awaitly/run';

type DbError =
  | { type: 'NOT_FOUND' }
  | { type: 'UNIQUE_VIOLATION'; field: string }
  | { type: 'DB_ERROR'; message: string };

const findUser = async (id: string): AsyncResult<User, DbError> => {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    return ok(user);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2025') return err({ type: 'NOT_FOUND' });
    }
    return err({ type: 'DB_ERROR', message: String(e) });
  }
};

// Use in a workflow
const result = await run(async ({ step }) => {
  const user = await step('findUser', () => findUser('user-123'));
  return user;
}, { onError: () => {} });
```

## Patterns

### Pattern 1: Wrapping Common Prisma Operations

Create a generic wrapper for Prisma operations:

```typescript
import { Prisma, PrismaClient } from '@prisma/client';
import { ok, err, type AsyncResult } from 'awaitly';

const prisma = new PrismaClient();

// Common database error types
type DbError =
  | { type: 'NOT_FOUND'; entity?: string }
  | { type: 'UNIQUE_VIOLATION'; field: string }
  | { type: 'FOREIGN_KEY_VIOLATION'; field: string }
  | { type: 'DB_ERROR'; code?: string; message: string };

// Generic wrapper
const prismaToResult = async <T>(
  operation: () => Promise<T>,
  entity?: string
): AsyncResult<T, DbError> => {
  try {
    return ok(await operation());
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      switch (e.code) {
        case 'P2025': // Record not found
          return err({ type: 'NOT_FOUND', entity });
        case 'P2002': // Unique constraint violation
          return err({
            type: 'UNIQUE_VIOLATION',
            field: (e.meta?.target as string[])?.join(', ') ?? 'unknown'
          });
        case 'P2003': // Foreign key constraint violation
          return err({
            type: 'FOREIGN_KEY_VIOLATION',
            field: (e.meta?.field_name as string) ?? 'unknown'
          });
        default:
          return err({ type: 'DB_ERROR', code: e.code, message: e.message });
      }
    }
    return err({ type: 'DB_ERROR', message: String(e) });
  }
};

// Usage
const user = await prismaToResult(
  () => prisma.user.findUniqueOrThrow({ where: { id } }),
  'User'
);
```

### Pattern 2: Typed Repository Functions

Create repository functions with explicit error types:

```typescript
import { ok, err, type AsyncResult } from 'awaitly';

type UserNotFoundError = { type: 'USER_NOT_FOUND'; id: string };
type EmailTakenError = { type: 'EMAIL_TAKEN'; email: string };
type DbError = { type: 'DB_ERROR'; message: string };

// Repository with typed errors
const userRepository = {
  findById: async (id: string): AsyncResult<User, UserNotFoundError | DbError> => {
    try {
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return err({ type: 'USER_NOT_FOUND', id });
      return ok(user);
    } catch (e) {
      return err({ type: 'DB_ERROR', message: String(e) });
    }
  },

  create: async (data: { email: string; name: string }): AsyncResult<User, EmailTakenError | DbError> => {
    try {
      const user = await prisma.user.create({ data });
      return ok(user);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return err({ type: 'EMAIL_TAKEN', email: data.email });
      }
      return err({ type: 'DB_ERROR', message: String(e) });
    }
  },

  update: async (id: string, data: Partial<User>): AsyncResult<User, UserNotFoundError | DbError> => {
    try {
      const user = await prisma.user.update({ where: { id }, data });
      return ok(user);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return err({ type: 'USER_NOT_FOUND', id });
      }
      return err({ type: 'DB_ERROR', message: String(e) });
    }
  },

  delete: async (id: string): AsyncResult<void, UserNotFoundError | DbError> => {
    try {
      await prisma.user.delete({ where: { id } });
      return ok(undefined);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return err({ type: 'USER_NOT_FOUND', id });
      }
      return err({ type: 'DB_ERROR', message: String(e) });
    }
  },
};
```

### Pattern 3: In Workflows with Validation

Combine Prisma with Zod validation:

```typescript
import { run } from 'awaitly/run';
import { zodToResult } from './zod-result';
import { userRepository } from './user-repository';

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  role: z.enum(['user', 'admin']).default('user'),
});

const createUser = async (rawInput: unknown) => {
  return run(async ({ step }) => {
    // Validate input
    const input = await step('validateInput', () => zodToResult(CreateUserSchema, rawInput));

    // Create in database
    const user = await step('createUser', () => userRepository.create(input));

    return user;
  }, { onError: () => {} });
};

// Error type is: ValidationError | EmailTakenError | DbError
```

### Pattern 4: Transactions with Saga Pattern

Use Awaitly's saga pattern for transactions that need compensation:

```typescript
import { createSagaWorkflow } from 'awaitly/saga';

const transferFunds = createSagaWorkflow({
  debitAccount: async (accountId: string, amount: number) => {
    return prismaToResult(() =>
      prisma.account.update({
        where: { id: accountId },
        data: { balance: { decrement: amount } },
      })
    );
  },
  creditAccount: async (accountId: string, amount: number) => {
    return prismaToResult(() =>
      prisma.account.update({
        where: { id: accountId },
        data: { balance: { increment: amount } },
      })
    );
  },
  createTransaction: async (data: TransactionData) => {
    return prismaToResult(() => prisma.transaction.create({ data }));
  },
});

const result = await transferFunds(async (ctx, deps) => {
  // Debit source account
  await ctx.step(
    () => deps.debitAccount(sourceId, amount),
    { compensate: () => deps.creditAccount(sourceId, amount) } // Rollback on failure
  );

  // Credit destination account
  await ctx.step(
    () => deps.creditAccount(destId, amount),
    { compensate: () => deps.debitAccount(destId, amount) }
  );

  // Record transaction
  await ctx.step(() => deps.createTransaction({
    sourceId,
    destId,
    amount,
    timestamp: new Date(),
  }));

  return { success: true };
});
```

### Pattern 5: Handling Specific Error Codes

Map Prisma error codes to business errors:

```typescript
import { Prisma } from '@prisma/client';
import { err, type AsyncResult } from 'awaitly';

// Prisma error codes reference:
// P2000 - Value too long
// P2002 - Unique constraint violation
// P2003 - Foreign key constraint violation
// P2025 - Record not found
// See: https://www.prisma.io/docs/reference/api-reference/error-reference

type OrderError =
  | { type: 'ORDER_NOT_FOUND'; orderId: string }
  | { type: 'PRODUCT_NOT_FOUND'; productId: string }
  | { type: 'DUPLICATE_ORDER'; orderNumber: string }
  | { type: 'DB_ERROR'; message: string };

const mapPrismaError = (e: unknown, context: { orderId?: string; productId?: string; orderNumber?: string }): OrderError => {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case 'P2025':
        // Determine which entity wasn't found based on context
        if (context.orderId) return { type: 'ORDER_NOT_FOUND', orderId: context.orderId };
        if (context.productId) return { type: 'PRODUCT_NOT_FOUND', productId: context.productId };
        return { type: 'DB_ERROR', message: 'Record not found' };

      case 'P2002':
        if (context.orderNumber) return { type: 'DUPLICATE_ORDER', orderNumber: context.orderNumber };
        return { type: 'DB_ERROR', message: 'Duplicate record' };

      default:
        return { type: 'DB_ERROR', message: e.message };
    }
  }
  return { type: 'DB_ERROR', message: String(e) };
};

const createOrder = async (data: CreateOrderInput): AsyncResult<Order, OrderError> => {
  try {
    const order = await prisma.order.create({
      data: {
        orderNumber: data.orderNumber,
        items: {
          create: data.items.map(item => ({
            productId: item.productId,
            quantity: item.quantity,
          })),
        },
      },
      include: { items: true },
    });
    return ok(order);
  } catch (e) {
    return err(mapPrismaError(e, { orderNumber: data.orderNumber }));
  }
};
```

## Real Example: User Signup with Validation + Database

Complete workflow combining Zod validation, email checking, and user creation:

```typescript
import { z } from 'zod';
import { Prisma, PrismaClient } from '@prisma/client';
import { ok, err, type AsyncResult } from 'awaitly';
import { run } from 'awaitly/run';

const prisma = new PrismaClient();

// Schemas
const SignUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(100),
});

// Error types
type ValidationError = { type: 'VALIDATION'; issues: z.ZodIssue[] };
type EmailTakenError = { type: 'EMAIL_TAKEN'; email: string };
type DbError = { type: 'DB_ERROR'; message: string };

type SignUpError = ValidationError | EmailTakenError | DbError;

// Helpers
const zodToResult = <T>(schema: z.ZodSchema<T>, data: unknown) => {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION' as const, issues: parsed.error.issues });
};

const hashPassword = async (password: string): Promise<string> => {
  // In real code, use bcrypt or argon2
  return `hashed_${password}`;
};

// Sign up workflow
const signUp = async (rawInput: unknown): AsyncResult<{ id: string; email: string; name: string }, SignUpError> => {
  return run(async ({ step }) => {
    // Step 1: Validate input
    const input = await step('validateInput', () => zodToResult(SignUpSchema, rawInput));

    // Step 2: Hash password
    const passwordHash = await hashPassword(input.password);

    // Step 3: Create user (handles unique constraint)
    const createUserResult = async (): AsyncResult<{ id: string; email: string; name: string }, EmailTakenError | DbError> => {
      try {
        const user = await prisma.user.create({
          data: {
            email: input.email,
            passwordHash,
            name: input.name,
          },
          select: { id: true, email: true, name: true },
        });
        return ok(user);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return err({ type: 'EMAIL_TAKEN', email: input.email });
        }
        return err({ type: 'DB_ERROR', message: String(e) });
      }
    };

    const user = await step('createUser', () => createUserResult());

    return user;
  }, { onError: () => {} }) as AsyncResult<{ id: string; email: string; name: string }, SignUpError>;
};

// API handler
export const POST = async (request: Request) => {
  const result = await signUp(await request.json());

  if (!result.ok) {
    switch (result.error.type) {
      case 'VALIDATION':
        return Response.json(
          { error: 'Validation failed', issues: result.error.issues },
          { status: 400 }
        );
      case 'EMAIL_TAKEN':
        return Response.json(
          { error: 'Email already registered' },
          { status: 409 }
        );
      case 'DB_ERROR':
        console.error('Database error:', result.error.message);
        return Response.json(
          { error: 'Server error' },
          { status: 500 }
        );
    }
  }

  return Response.json(result.value, { status: 201 });
};
```

## Incremental Adoption

### Step 1: Create the Prisma wrapper

```typescript
// src/lib/prisma-result.ts
import { Prisma } from '@prisma/client';
import { ok, err, type AsyncResult } from 'awaitly';

export type DbError =
  | { type: 'NOT_FOUND'; entity?: string }
  | { type: 'UNIQUE_VIOLATION'; field: string }
  | { type: 'FOREIGN_KEY_VIOLATION'; field: string }
  | { type: 'DB_ERROR'; code?: string; message: string };

export const prismaToResult = async <T>(
  operation: () => Promise<T>,
  entity?: string
): AsyncResult<T, DbError> => {
  try {
    return ok(await operation());
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      switch (e.code) {
        case 'P2025':
          return err({ type: 'NOT_FOUND', entity });
        case 'P2002':
          return err({
            type: 'UNIQUE_VIOLATION',
            field: (e.meta?.target as string[])?.join(', ') ?? 'unknown'
          });
        case 'P2003':
          return err({
            type: 'FOREIGN_KEY_VIOLATION',
            field: (e.meta?.field_name as string) ?? 'unknown'
          });
        default:
          return err({ type: 'DB_ERROR', code: e.code, message: e.message });
      }
    }
    return err({ type: 'DB_ERROR', message: String(e) });
  }
};
```

### Step 2: Use in one service

```typescript
// Before: try/catch everywhere
const getUser = async (id: string) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    return user;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      throw new NotFoundError('User not found');
    }
    throw e;
  }
};

// After: typed Result
const getUser = async (id: string) => {
  return prismaToResult(
    () => prisma.user.findUniqueOrThrow({ where: { id } }),
    'User'
  );
};
```

### Step 3: Create domain repositories

Build typed repositories for each entity with specific error types.

## Common Utilities

```typescript
// src/lib/prisma-result.ts

import { Prisma } from '@prisma/client';
import { ok, err, type AsyncResult } from 'awaitly';

export type DbError =
  | { type: 'NOT_FOUND'; entity?: string }
  | { type: 'UNIQUE_VIOLATION'; field: string }
  | { type: 'FOREIGN_KEY_VIOLATION'; field: string }
  | { type: 'DB_ERROR'; code?: string; message: string };

/**
 * Wrap a Prisma operation and convert errors to typed Results
 */
export const prismaToResult = async <T>(
  operation: () => Promise<T>,
  entity?: string
): AsyncResult<T, DbError> => {
  try {
    return ok(await operation());
  } catch (e) {
    return err(mapPrismaError(e, entity));
  }
};

/**
 * Map Prisma errors to typed DbError
 */
export const mapPrismaError = (e: unknown, entity?: string): DbError => {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case 'P2025':
        return { type: 'NOT_FOUND', entity };
      case 'P2002':
        return {
          type: 'UNIQUE_VIOLATION',
          field: (e.meta?.target as string[])?.join(', ') ?? 'unknown'
        };
      case 'P2003':
        return {
          type: 'FOREIGN_KEY_VIOLATION',
          field: (e.meta?.field_name as string) ?? 'unknown'
        };
      default:
        return { type: 'DB_ERROR', code: e.code, message: e.message };
    }
  }
  return { type: 'DB_ERROR', message: String(e) };
};

/**
 * Check if an error is a specific Prisma error code
 */
export const isPrismaError = (e: unknown, code: string): boolean => {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === code;
};

/**
 * Wrap findUnique to return Result with NOT_FOUND error
 */
export const findOrNotFound = async <T>(
  operation: () => Promise<T | null>,
  entity: string
): AsyncResult<T, { type: 'NOT_FOUND'; entity: string }> => {
  const result = await operation();
  return result !== null
    ? ok(result)
    : err({ type: 'NOT_FOUND', entity });
};
```

## Tips

1. **Use `findUniqueOrThrow`**: It throws P2025, which you can map to `NOT_FOUND`
2. **Check `e.meta`**: Prisma includes useful metadata like the violated field
3. **Create entity-specific errors**: `USER_NOT_FOUND` is clearer than `NOT_FOUND`
4. **Log original errors**: Keep the raw Prisma error for debugging while returning typed errors
5. **Consider transactions**: Use `prisma.$transaction` inside the wrapper for atomic operations
