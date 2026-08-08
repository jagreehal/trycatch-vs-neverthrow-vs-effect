# Using Zod with Awaitly

Turn Zod validation errors into typed Results for seamless composition in workflows.

## Why Combine Them?

- **Type-safe validation errors**: Know exactly what went wrong, not just "validation failed"
- **Composable with other operations**: Chain validation with database calls, API requests, etc.
- **Early exit on invalid input**: `step()` stops the workflow immediately on validation failure

## Quick Start

```typescript
import { z } from 'zod';
import { ok, err, type Result } from 'awaitly';
import { run } from 'awaitly';

const UserSchema = z.object({
  email: z.string().email(),
  age: z.number().min(18),
});

type User = z.infer<typeof UserSchema>;
type ValidationError = { type: 'VALIDATION'; issues: z.ZodIssue[] };

// Convert Zod's safeParse to a Result
const zodToResult = <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Result<T, ValidationError> => {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION', issues: parsed.error.issues });
};

// Use with run(deps, fn)
const validateUser = () =>
  zodToResult(UserSchema, { email: 'test@example.com', age: 25 });

const result = await run({ validateUser }, async (s) => s.validateUser());
```

## Patterns

### Pattern 1: Basic Schema Validation

The simplest pattern: validate input and return a typed Result:

```typescript
import { z } from 'zod';
import { ok, err, type Result } from 'awaitly';

// Define your schema
const CreateUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().optional(),
});

type CreateUserInput = z.infer<typeof CreateUserSchema>;

// Validation error with full issue details
type ValidationError = {
  type: 'VALIDATION';
  issues: z.ZodIssue[];
};

// Generic helper (copy this to your utils)
export const zodToResult = <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Result<T, ValidationError> => {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION', issues: parsed.error.issues });
};

// Usage
const input = zodToResult(CreateUserSchema, requestBody);
// input: Result<CreateUserInput, ValidationError>
```

### Pattern 2: With run(deps, fn)

Compose validation with other operations:

```typescript
import { run } from 'awaitly';
import { zodToResult } from './utils';

const createUser = async (rawInput: unknown) => {
  const validateInput = () => zodToResult(CreateUserSchema, rawInput);
  const saveUser = (input: CreateUserInput) => saveToDatabase(input);
  const sendWelcome = (email: string) => sendWelcomeEmail(email);

  return run({ validateInput, saveUser, sendWelcome }, async (s) => {
    const input = await s.validateInput();
    const user = await s.saveUser(input);
    await s.sendWelcome(user.email);
    return user;
  });
};

// Error type is inferred from deps: ValidationError | DbError | EmailError | UnexpectedError
```

### Pattern 3: Form Validation in React

Return validation results to forms:

```typescript
import { z } from 'zod';
import { zodToResult } from './utils';

const SignUpSchema = z.object({
  email: z.string().email('Please enter a valid email'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters')
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[0-9]/, 'Password must contain a number'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

// In your form handler
const handleSubmit = async (formData: FormData) => {
  const raw = Object.fromEntries(formData);
  const validation = zodToResult(SignUpSchema, raw);

  if (!validation.ok) {
    // Convert Zod issues to field errors for your form library
    const fieldErrors = validation.error.issues.reduce((acc, issue) => {
      const field = issue.path.join('.');
      acc[field] = issue.message;
      return acc;
    }, {} as Record<string, string>);

    return { success: false, errors: fieldErrors };
  }

  // Proceed with valid data
  const result = await createUser(validation.value);
  return result.ok
    ? { success: true, user: result.value }
    : { success: false, error: result.error };
};
```

### Pattern 4: API Request Validation

Validate incoming API requests:

```typescript
import { run, isUnexpectedError } from 'awaitly';
import { zodToResult } from './utils';

// Define request schemas
const CreatePostSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  tags: z.array(z.string()).max(10).optional(),
});

const PostIdSchema = z.object({
  id: z.string().uuid('Invalid post ID format'),
});

// API handler
export const POST = async (request: Request) => {
  const body = await request.json();

  // Deps first: the error union is inferred, so no type parameters and no cast
  const result = await run(
    {
      validateInput: async () => zodToResult(CreatePostSchema, body),
      createPost,
    },
    async (s) => {
      const input = await s.validateInput();
      return await s.createPost(input);
    }
  );
  // result.error: ValidationError | DbError | UnexpectedError

  if (!result.ok) {
    if (isUnexpectedError(result.error)) {
      console.error('Bug:', result.error.cause);
      return Response.json({ error: 'Server error' }, { status: 500 });
    }
    if (result.error.type === 'VALIDATION') {
      return Response.json(
        { error: 'Validation failed', issues: result.error.issues },
        { status: 400 }
      );
    }
    return Response.json({ error: 'Server error' }, { status: 500 });
  }

  return Response.json(result.value, { status: 201 });
};
```

### Pattern 5: Nested Schema Validation

Handle complex nested data:

```typescript
const AddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  country: z.string(),
  postalCode: z.string(),
});

const OrderSchema = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).min(1, 'Order must have at least one item'),
  shippingAddress: AddressSchema,
  billingAddress: AddressSchema.optional(),
});

// Validate with detailed error paths
const validateOrder = (data: unknown) => {
  const result = zodToResult(OrderSchema, data);

  if (!result.ok) {
    // Issues include full paths like 'items.0.quantity' or 'shippingAddress.city'
    console.log(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`));
  }

  return result;
};
```

## Real Example: User Registration Flow

Complete, runnable example combining Zod validation with a workflow:

```typescript
import { z } from 'zod';
import { ok, err, run, type Result, type AsyncResult } from 'awaitly';

// Schemas
const EmailSchema = z.string().email();
const PasswordSchema = z.string()
  .min(8)
  .regex(/[A-Z]/, 'Must contain uppercase')
  .regex(/[a-z]/, 'Must contain lowercase')
  .regex(/[0-9]/, 'Must contain number');

const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: z.string().min(2).max(100),
});

// Error types
type ValidationError = { type: 'VALIDATION'; issues: z.ZodIssue[] };
type EmailTakenError = { type: 'EMAIL_TAKEN'; email: string };
type DbError = { type: 'DB_ERROR'; message: string };

type RegisterError = ValidationError | EmailTakenError | DbError;

// Helper
const zodToResult = <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Result<T, ValidationError> => {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION', issues: parsed.error.issues });
};

// Mock database functions — a dep returns the domain error, so the workflow
// callback never calls err() itself
const ensureEmailAvailable = async (
  email: string
): AsyncResult<string, EmailTakenError | DbError> => {
  // In real code, this would query the database
  const taken = false;
  return taken ? err({ type: 'EMAIL_TAKEN', email }) : ok(email);
};

const createUser = async (data: { email: string; password: string; name: string }): AsyncResult<{ id: string; email: string; name: string }, DbError> => {
  return ok({ id: '123', email: data.email, name: data.name });
};

// Registration workflow — deps first, no type parameters, no cast
const register = (rawInput: unknown) =>
  run(
    {
      validateInput: async () => zodToResult(RegisterSchema, rawInput),
      ensureEmailAvailable,
      createUser,
    },
    async (s) => {
      const input = await s.validateInput();
      await s.ensureEmailAvailable(input.email);
      return await s.createUser(input);
    }
  );
// register(...) resolves to
//   AsyncResult<{ id, email, name }, RegisterError | UnexpectedError>
// with RegisterError spelled out on hover, not hidden behind an alias

// Usage
const result = await register({
  email: 'user@example.com',
  password: 'SecurePass123',
  name: 'Jane Doe',
});

if (!result.ok) {
  switch (result.error.type) {
    case 'VALIDATION':
      console.log('Invalid input:', result.error.issues);
      break;
    case 'EMAIL_TAKEN':
      console.log('Email already registered:', result.error.email);
      break;
    case 'DB_ERROR':
      console.log('Database error:', result.error.message);
      break;
  }
}
```

## Incremental Adoption

### Step 1: Add the helper to your project

```typescript
// src/lib/zod-result.ts
import { z } from 'zod';
import { ok, err, type Result } from 'awaitly';

export type ValidationError = {
  type: 'VALIDATION';
  issues: z.ZodIssue[];
};

export const zodToResult = <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Result<T, ValidationError> => {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION', issues: parsed.error.issues });
};

// Async version for schemas with async refinements
export const zodToResultAsync = async <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Promise<Result<T, ValidationError>> => {
  const parsed = await schema.safeParseAsync(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION', issues: parsed.error.issues });
};
```

### Step 2: Use in one endpoint

```typescript
// Before
const handler = async (req: Request) => {
  try {
    const body = MySchema.parse(await req.json()); // throws
    const result = await doSomething(body);
    return Response.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json({ error: e.issues }, { status: 400 });
    }
    return Response.json({ error: 'Server error' }, { status: 500 });
  }
};

// After
import { run } from 'awaitly';

const handler = async (req: Request) => {
  const validation = zodToResult(MySchema, await req.json());

  if (!validation.ok) {
    return Response.json({ error: validation.error.issues }, { status: 400 });
  }

  const result = await run({ doSomething }, async (s) => s.doSomething(validation.value));

  if (!result.ok) {
    return Response.json({ error: 'Server error' }, { status: 500 });
  }

  return Response.json(result.value);
};
```

### Step 3: Expand to more endpoints

Once you're comfortable with the pattern, apply it consistently across your API.

## Common Utilities

```typescript
// src/lib/zod-result.ts

import { z } from 'zod';
import { ok, err, type Result } from 'awaitly';

export type ValidationError = {
  type: 'VALIDATION';
  issues: z.ZodIssue[];
};

/**
 * Convert Zod safeParse to Result
 */
export const zodToResult = <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Result<T, ValidationError> => {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION', issues: parsed.error.issues });
};

/**
 * Async version for schemas with async refinements
 */
export const zodToResultAsync = async <T>(
  schema: z.ZodSchema<T>,
  data: unknown
): Promise<Result<T, ValidationError>> => {
  const parsed = await schema.safeParseAsync(data);
  return parsed.success
    ? ok(parsed.data)
    : err({ type: 'VALIDATION', issues: parsed.error.issues });
};

/**
 * Convert Zod issues to a field error map (useful for forms)
 */
export const issuesToFieldErrors = (issues: z.ZodIssue[]): Record<string, string> => {
  return issues.reduce((acc, issue) => {
    const field = issue.path.join('.') || '_root';
    acc[field] = issue.message;
    return acc;
  }, {} as Record<string, string>);
};

/**
 * Get the first error message (useful for simple error displays)
 */
export const getFirstError = (error: ValidationError): string => {
  return error.issues[0]?.message ?? 'Validation failed';
};
```

## Tips

1. **Use descriptive error messages in schemas**: They appear in the `issues` array
2. **Leverage Zod's `path`**: It tells you exactly which field failed
3. **Combine with `step.try()`**: For schemas with async refinements that might throw
4. **Create domain-specific schemas**: `EmailSchema`, `UUIDSchema`, etc. for reuse
