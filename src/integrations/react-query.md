# Using React Query with Awaitly

Combine TanStack Query's server state management with Awaitly's typed Results for exhaustive error handling in your React components.

## Why Combine Them?

- **Type-safe errors in components**: Handle `NOT_FOUND`, `UNAUTHORIZED`, etc. explicitly
- **Server returns Result, client handles**: Clean separation of concerns
- **Works with React Server Components**: Same patterns work with RSC and server actions

## Quick Start

```typescript
// Server: Return AsyncResult from API
import { ok, err, type AsyncResult } from 'awaitly';

type ApiError =
  | { type: 'NOT_FOUND' }
  | { type: 'UNAUTHORIZED' };

export const getUser = async (id: string): AsyncResult<User, ApiError> => {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) return err({ type: 'NOT_FOUND' });
  return ok(user);
};

// Client: Handle Result in useQuery
import { useQuery } from '@tanstack/react-query';

function UserProfile({ userId }: { userId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['user', userId],
    queryFn: async () => {
      const result = await getUser(userId);
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorDisplay error={error} />;
  return <div>{data.name}</div>;
}
```

## Patterns

### Pattern 1: Server Returns Result, Client Unwraps

The foundational pattern: your server functions return `AsyncResult`, and the client unwraps them:

```typescript
// ============ Server Side ============
// src/api/users.ts
import { ok, err, type AsyncResult } from 'awaitly';

type UserError =
  | { type: 'NOT_FOUND'; id: string }
  | { type: 'UNAUTHORIZED' }
  | { type: 'SERVER_ERROR'; message: string };

export const getUser = async (id: string): AsyncResult<User, UserError> => {
  // Auth check
  const session = await getSession();
  if (!session) return err({ type: 'UNAUTHORIZED' });

  // Database query
  const user = await db.user.findUnique({ where: { id } });
  if (!user) return err({ type: 'NOT_FOUND', id });

  return ok(user);
};

// ============ Client Side ============
// src/hooks/useUser.ts
import { useQuery } from '@tanstack/react-query';
import { getUser, type UserError } from '@/api/users';

// Custom error class to preserve the typed error
class ResultError<E> extends Error {
  constructor(public readonly error: E) {
    super(JSON.stringify(error));
    this.name = 'ResultError';
  }
}

export const useUser = (id: string) => {
  return useQuery({
    queryKey: ['user', id],
    queryFn: async () => {
      const result = await getUser(id);
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
    retry: (failureCount, error) => {
      // Don't retry on NOT_FOUND or UNAUTHORIZED
      if (error instanceof ResultError) {
        const e = error.error as UserError;
        if (e.type === 'NOT_FOUND' || e.type === 'UNAUTHORIZED') {
          return false;
        }
      }
      return failureCount < 3;
    },
  });
};
```

### Pattern 2: Type-Safe Error Handling in Components

Handle specific error types in your UI:

```typescript
import { useUser } from '@/hooks/useUser';

function UserProfile({ userId }: { userId: string }) {
  const { data: user, error, isLoading, isError } = useUser(userId);

  if (isLoading) {
    return <Skeleton />;
  }

  if (isError && error instanceof ResultError) {
    const apiError = error.error as UserError;

    switch (apiError.type) {
      case 'NOT_FOUND':
        return (
          <EmptyState
            title="User not found"
            description={`No user exists with ID ${apiError.id}`}
          />
        );

      case 'UNAUTHORIZED':
        return <LoginPrompt message="Please sign in to view this profile" />;

      case 'SERVER_ERROR':
        return (
          <ErrorState
            title="Something went wrong"
            description={apiError.message}
            retry={() => refetch()}
          />
        );
    }
  }

  // TypeScript knows user is defined here
  return (
    <div>
      <h1>{user.name}</h1>
      <p>{user.email}</p>
    </div>
  );
}
```

### Pattern 3: useMutation with Result-Returning Actions

Handle form submissions with typed errors:

```typescript
// Server action
import { ok, err, type AsyncResult } from 'awaitly';

type CreateUserError =
  | { type: 'VALIDATION'; issues: { field: string; message: string }[] }
  | { type: 'EMAIL_TAKEN'; email: string }
  | { type: 'SERVER_ERROR' };

export const createUser = async (
  data: CreateUserInput
): AsyncResult<User, CreateUserError> => {
  // Validation
  const validation = CreateUserSchema.safeParse(data);
  if (!validation.success) {
    return err({
      type: 'VALIDATION',
      issues: validation.error.issues.map(i => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  // Create user
  try {
    const user = await db.user.create({ data: validation.data });
    return ok(user);
  } catch (e) {
    if (isPrismaUniqueConstraintError(e)) {
      return err({ type: 'EMAIL_TAKEN', email: data.email });
    }
    return err({ type: 'SERVER_ERROR' });
  }
};

// Client hook
import { useMutation, useQueryClient } from '@tanstack/react-query';

export const useCreateUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateUserInput) => {
      const result = await createUser(data);
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
    onSuccess: (user) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.setQueryData(['user', user.id], user);
    },
  });
};

// Component
function CreateUserForm() {
  const mutation = useCreateUser();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFieldErrors({});

    try {
      await mutation.mutateAsync(formData);
      toast.success('User created!');
    } catch (error) {
      if (error instanceof ResultError) {
        const apiError = error.error as CreateUserError;

        switch (apiError.type) {
          case 'VALIDATION':
            setFieldErrors(
              Object.fromEntries(apiError.issues.map(i => [i.field, i.message]))
            );
            break;
          case 'EMAIL_TAKEN':
            setFieldErrors({ email: 'This email is already registered' });
            break;
          case 'SERVER_ERROR':
            toast.error('Something went wrong. Please try again.');
            break;
        }
      }
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Input
        name="email"
        error={fieldErrors.email}
        disabled={mutation.isPending}
      />
      <Input
        name="name"
        error={fieldErrors.name}
        disabled={mutation.isPending}
      />
      <Button type="submit" loading={mutation.isPending}>
        Create User
      </Button>
    </form>
  );
}
```

### Pattern 4: With React Server Components

Use Results in Server Components and Server Actions:

```typescript
// app/users/[id]/page.tsx (Server Component)
import { getUser } from '@/api/users';

export default async function UserPage({ params }: { params: { id: string } }) {
  const result = await getUser(params.id);

  if (!result.ok) {
    switch (result.error.type) {
      case 'NOT_FOUND':
        return notFound();
      case 'UNAUTHORIZED':
        return redirect('/login');
      case 'SERVER_ERROR':
        throw new Error(result.error.message); // Triggers error.tsx
    }
  }

  return <UserProfile user={result.value} />;
}

// app/users/actions.ts (Server Action)
'use server';

import { ok, err, type AsyncResult } from 'awaitly';

type UpdateUserError =
  | { type: 'NOT_FOUND' }
  | { type: 'VALIDATION'; message: string };

export const updateUser = async (
  id: string,
  data: UpdateUserInput
): AsyncResult<User, UpdateUserError> => {
  const validation = UpdateUserSchema.safeParse(data);
  if (!validation.success) {
    return err({ type: 'VALIDATION', message: validation.error.issues[0].message });
  }

  const user = await db.user.update({
    where: { id },
    data: validation.data,
  }).catch(() => null);

  if (!user) return err({ type: 'NOT_FOUND' });
  return ok(user);
};

// Client Component using the action
'use client';

import { updateUser } from './actions';
import { useTransition } from 'react';

function EditUserForm({ user }: { user: User }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (formData: FormData) => {
    startTransition(async () => {
      const result = await updateUser(user.id, Object.fromEntries(formData));

      if (!result.ok) {
        switch (result.error.type) {
          case 'NOT_FOUND':
            setError('User no longer exists');
            break;
          case 'VALIDATION':
            setError(result.error.message);
            break;
        }
        return;
      }

      setError(null);
      toast.success('Updated!');
    });
  };

  return (
    <form action={handleSubmit}>
      {error && <Alert variant="error">{error}</Alert>}
      <Input name="name" defaultValue={user.name} disabled={isPending} />
      <Button type="submit" loading={isPending}>Save</Button>
    </form>
  );
}
```

### Pattern 5: Composing with Zod Validation

Combine React Query, Awaitly, and Zod for full-stack type safety:

```typescript
// Shared schema (used on both client and server)
// src/schemas/user.ts
import { z } from 'zod';

export const CreateUserSchema = z.object({
  email: z.string().email('Invalid email'),
  name: z.string().min(2, 'Name too short').max(100, 'Name too long'),
  role: z.enum(['user', 'admin']).default('user'),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

// Server
// src/api/users.ts
import { Awaitly, ok, err, type AsyncResult } from 'awaitly';
import { run } from 'awaitly/run';
import { CreateUserSchema } from '@/schemas/user';

type CreateUserError =
  | { type: 'VALIDATION'; issues: z.ZodIssue[] }
  | { type: 'EMAIL_TAKEN' }
  | { type: 'DB_ERROR' };

export const createUser = async (
  input: unknown
): AsyncResult<User, CreateUserError> => {
  return run(async ({ step }) => {
    // Validate
    const data = await step('validateInput', () => zodToResult(CreateUserSchema, input));

    // Create
    const user = await step('createUser', () => prismaToResult(() =>
      db.user.create({ data })
    ));

    return user;
  }, { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }) as AsyncResult<User, CreateUserError>;
};

// Client hook with optimistic updates
export const useCreateUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateUserInput) => {
      const result = await createUser(input);
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
    // Optimistic update
    onMutate: async (newUser) => {
      await queryClient.cancelQueries({ queryKey: ['users'] });
      const previousUsers = queryClient.getQueryData<User[]>(['users']);

      queryClient.setQueryData<User[]>(['users'], (old = []) => [
        ...old,
        { ...newUser, id: 'temp-' + Date.now() },
      ]);

      return { previousUsers };
    },
    onError: (err, newUser, context) => {
      // Rollback on error
      queryClient.setQueryData(['users'], context?.previousUsers);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};
```

## Real Example: Full CRUD with React Query

Complete example with list, detail, create, update, and delete:

```typescript
// ============ Types ============
type User = { id: string; name: string; email: string };

type UserError =
  | { type: 'NOT_FOUND'; id: string }
  | { type: 'VALIDATION'; issues: { field: string; message: string }[] }
  | { type: 'EMAIL_TAKEN' }
  | { type: 'UNAUTHORIZED' }
  | { type: 'SERVER_ERROR' };

// ============ ResultError Helper ============
class ResultError<E> extends Error {
  constructor(public readonly error: E) {
    super(JSON.stringify(error));
    this.name = 'ResultError';
  }

  static is<E>(error: unknown): error is ResultError<E> {
    return error instanceof ResultError;
  }
}

// ============ API Functions ============
// (These would typically be in separate files)

const api = {
  getUsers: async (): AsyncResult<User[], UserError> => {
    // Implementation
    return ok([]);
  },

  getUser: async (id: string): AsyncResult<User, UserError> => {
    // Implementation
    return ok({ id, name: 'Test', email: 'test@example.com' });
  },

  createUser: async (data: CreateUserInput): AsyncResult<User, UserError> => {
    // Implementation
    return ok({ id: '1', ...data });
  },

  updateUser: async (id: string, data: UpdateUserInput): AsyncResult<User, UserError> => {
    // Implementation
    return ok({ id, ...data, email: 'test@example.com' });
  },

  deleteUser: async (id: string): AsyncResult<void, UserError> => {
    // Implementation
    return ok(undefined);
  },
};

// ============ Hooks ============
export const useUsers = () => {
  return useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const result = await api.getUsers();
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
  });
};

export const useUser = (id: string) => {
  return useQuery({
    queryKey: ['user', id],
    queryFn: async () => {
      const result = await api.getUser(id);
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
    enabled: !!id,
  });
};

export const useCreateUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateUserInput) => {
      const result = await api.createUser(data);
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
};

export const useUpdateUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateUserInput }) => {
      const result = await api.updateUser(id, data);
      if (!result.ok) throw new ResultError(result.error);
      return result.value;
    },
    onSuccess: (user) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.setQueryData(['user', user.id], user);
    },
  });
};

export const useDeleteUser = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const result = await api.deleteUser(id);
      if (!result.ok) throw new ResultError(result.error);
    },
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.removeQueries({ queryKey: ['user', id] });
    },
  });
};

// ============ Component ============
function UserList() {
  const { data: users, isLoading, error } = useUsers();
  const deleteMutation = useDeleteUser();

  if (isLoading) return <Spinner />;

  if (error && ResultError.is(error)) {
    const apiError = error.error as UserError;
    if (apiError.type === 'UNAUTHORIZED') {
      return <LoginPrompt />;
    }
    return <ErrorState error={apiError} />;
  }

  return (
    <ul>
      {users?.map(user => (
        <li key={user.id}>
          {user.name}
          <button
            onClick={() => deleteMutation.mutate(user.id)}
            disabled={deleteMutation.isPending}
          >
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}
```

## Common Utilities

```typescript
// src/lib/result-error.ts

/**
 * Error class that preserves typed error information from Results
 */
export class ResultError<E> extends Error {
  constructor(public readonly error: E) {
    super(typeof error === 'object' ? JSON.stringify(error) : String(error));
    this.name = 'ResultError';
  }

  /**
   * Type guard to check if an error is a ResultError
   */
  static is<E>(error: unknown): error is ResultError<E> {
    return error instanceof ResultError;
  }

  /**
   * Extract the typed error from a caught exception
   */
  static extract<E>(error: unknown): E | null {
    return ResultError.is<E>(error) ? error.error : null;
  }
}

/**
 * Unwrap a Result, throwing ResultError on failure
 * Useful in React Query queryFn
 */
export const unwrapOrThrow = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new ResultError(result.error);
  return result.value;
};

/**
 * Create a queryFn that unwraps Results
 */
export const resultQueryFn = <T, E>(
  fn: () => Promise<Result<T, E>>
) => async (): Promise<T> => {
  const result = await fn();
  return unwrapOrThrow(result);
};

// Usage:
const { data } = useQuery({
  queryKey: ['user', id],
  queryFn: resultQueryFn(() => getUser(id)),
});
```

## Tips

1. **Use `ResultError` class**: Preserves typed errors through React Query's error handling
2. **Conditional retry**: Don't retry on business errors like `NOT_FOUND` or `UNAUTHORIZED`
3. **Error boundaries**: Let `SERVER_ERROR` types bubble up to error boundaries
4. **Optimistic updates**: Rollback optimistic updates when Result is an error
5. **Server Components**: Use Results directly in RSC, no need for `useQuery`
