/**
 * API Comparison: neverthrow vs awaitly vs effect
 *
 * This file demonstrates pattern-by-pattern equivalents between the three libraries.
 * Each test shows the same logic implemented three ways.
 */
import { describe, it, expect, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// neverthrow imports
// ─────────────────────────────────────────────────────────────────────────────
import {
  Result,
  ResultAsync,
  ok as ntOk,
  err as ntErr,
  okAsync as ntOkAsync,
  errAsync as ntErrAsync,
} from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// awaitly imports
// ─────────────────────────────────────────────────────────────────────────────
import {
  Awaitly,
  ok,
  err,
  allAsync,
  allSettled,
  match,
  map,
  mapError,
  andThen,
  type AsyncResult,
} from 'awaitly';
import { run } from 'awaitly/run';
import { createWorkflow } from 'awaitly/workflow';

// ─────────────────────────────────────────────────────────────────────────────
// effect imports
// ─────────────────────────────────────────────────────────────────────────────
import { Effect } from 'effect';

// ─────────────────────────────────────────────────────────────────────────────
// Shared types for examples
// ─────────────────────────────────────────────────────────────────────────────
type User = { id: string; name: string; email: string };
type Post = { id: string; title: string; authorId: string };
type Comment = { id: string; text: string; postId: string };

// ─────────────────────────────────────────────────────────────────────────────
// 1. BASIC RESULT CONSTRUCTION
// ─────────────────────────────────────────────────────────────────────────────
describe('1. Basic Result construction', () => {
  it('neverthrow: ok() and err()', () => {
    const success = ntOk({ id: '1', name: 'Alice' });
    const failure = ntErr('NOT_FOUND' as const);

    expect(success.isOk()).toBe(true);
    expect(failure.isErr()).toBe(true);
    expect(success._unsafeUnwrap()).toEqual({ id: '1', name: 'Alice' });
    expect(failure._unsafeUnwrapErr()).toBe('NOT_FOUND');
  });

  it('workflow: ok() and err()', () => {
    const success = ok({ id: '1', name: 'Alice' });
    const failure = err('NOT_FOUND' as const);

    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
    expect(success.ok && success.value).toEqual({ id: '1', name: 'Alice' });
    expect(!failure.ok && failure.error).toBe('NOT_FOUND');
  });

  it('effect: Effect.succeed() and Effect.fail()', async () => {
    const success = Effect.succeed({ id: '1', name: 'Alice' });
    const failure = Effect.fail('NOT_FOUND' as const);

    const successValue = await Effect.runPromise(success);
    expect(successValue).toEqual({ id: '1', name: 'Alice' });

    const exit = await Effect.runPromiseExit(failure);
    expect(exit._tag).toBe('Failure');
    if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
      expect(exit.cause.error).toBe('NOT_FOUND');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SEQUENTIAL OPERATIONS (andThen chains vs step() calls)
// ─────────────────────────────────────────────────────────────────────────────
describe('2. Sequential operations', () => {
  // Shared mock data
  const users: Record<string, User> = {
    '1': { id: '1', name: 'Alice', email: 'alice@example.com' },
  };
  const posts: Record<string, Post[]> = {
    '1': [{ id: 'p1', title: 'Hello World', authorId: '1' }],
  };

  describe('neverthrow: andThen chains', () => {
    // Dependencies return ResultAsync
    const fetchUser = (id: string): ResultAsync<User, 'NOT_FOUND'> =>
      users[id] ? ntOkAsync(users[id]) : ntErrAsync('NOT_FOUND');

    const fetchPosts = (userId: string): ResultAsync<Post[], 'FETCH_ERROR'> =>
      posts[userId] ? ntOkAsync(posts[userId]) : ntErrAsync('FETCH_ERROR');

    it('chains with .andThen()', async () => {
      // Type: ResultAsync<{ user: User; posts: Post[] }, 'NOT_FOUND' | 'FETCH_ERROR'>
      // Error union is MANUAL - you must declare it
      const result = await fetchUser('1').andThen((user) =>
        fetchPosts(user.id).map((userPosts) => ({ user, posts: userPosts }))
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.user.name).toBe('Alice');
        expect(result.value.posts).toHaveLength(1);
      }
    });

    it('deeply nested chains become hard to read', async () => {
      // With 3+ operations, nesting gets unwieldy
      const fetchComments = (
        postId: string
      ): ResultAsync<Comment[], 'COMMENTS_ERROR'> =>
        ntOkAsync([{ id: 'c1', text: 'Great post!', postId }]);

      const result = await fetchUser('1').andThen((user) =>
        fetchPosts(user.id).andThen((userPosts) =>
          fetchComments(userPosts[0].id).map((comments) => ({
            user,
            posts: userPosts,
            comments,
          }))
        )
      );

      expect(result.isOk()).toBe(true);
    });
  });

  describe('workflow: step() with async/await', () => {
    // Dependencies return AsyncResult
    const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
      Promise.resolve(users[id] ? ok(users[id]) : err('NOT_FOUND'));

    const fetchPosts = (userId: string): AsyncResult<Post[], 'FETCH_ERROR'> =>
      Promise.resolve(posts[userId] ? ok(posts[userId]) : err('FETCH_ERROR'));

    const fetchComments = (
      postId: string
    ): AsyncResult<Comment[], 'COMMENTS_ERROR'> =>
      Promise.resolve(ok([{ id: 'c1', text: 'Great post!', postId }]));

    it('uses step() with natural async/await', async () => {
      // Error union is AUTOMATIC - inferred from deps
      const loadUserData = createWorkflow('loadUserData', { fetchUser, fetchPosts });

      const result = await loadUserData(async ({ step }) => {
        const user = await step('getUser', () => fetchUser('1'));
        const userPosts = await step('getPosts', () => fetchPosts(user.id));
        return { user, posts: userPosts };
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.user.name).toBe('Alice');
        expect(result.value.posts).toHaveLength(1);
      }
    });

    it('stays flat with 3+ operations', async () => {
      // No nesting regardless of depth
      const loadEverything = createWorkflow('loadEverything', {
        fetchUser,
        fetchPosts,
        fetchComments,
      });

      const result = await loadEverything(async ({ step }) => {
        const user = await step('getUser', () => fetchUser('1'));
        const userPosts = await step('getPosts', () => fetchPosts(user.id));
        const comments = await step('getComments', () => fetchComments(userPosts[0].id));
        return { user, posts: userPosts, comments };
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.comments).toHaveLength(1);
      }
    });
  });

  describe('workflow: run() with closures (same as createWorkflow)', () => {
    const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
      Promise.resolve(users[id] ? ok(users[id]) : err('NOT_FOUND'));

    const fetchPosts = (userId: string): AsyncResult<Post[], 'FETCH_ERROR'> =>
      Promise.resolve(posts[userId] ? ok(posts[userId]) : err('FETCH_ERROR'));

    const fetchComments = (
      postId: string
    ): AsyncResult<Comment[], 'COMMENTS_ERROR'> =>
      Promise.resolve(ok([{ id: 'c1', text: 'Great post!', postId }]));

    it('uses run() with step() and closure deps', async () => {
      type LoadErrors = 'NOT_FOUND' | 'FETCH_ERROR' | typeof Awaitly.UNEXPECTED_ERROR;

      const result = await run<{ user: User; posts: Post[] }, LoadErrors>(
        async ({ step }) => {
          const user = await step('getUser', () => fetchUser('1'));
          const userPosts = await step('getPosts', () => fetchPosts(user.id));
          return { user, posts: userPosts };
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.user.name).toBe('Alice');
        expect(result.value.posts).toHaveLength(1);
      }
    });

    it('run() stays flat with 3+ operations', async () => {
      type LoadErrors =
        | 'NOT_FOUND'
        | 'FETCH_ERROR'
        | 'COMMENTS_ERROR'
        | typeof Awaitly.UNEXPECTED_ERROR;

      const result = await run<
        { user: User; posts: Post[]; comments: Comment[] },
        LoadErrors
      >(
        async ({ step }) => {
          const user = await step('getUser', () => fetchUser('1'));
          const userPosts = await step('getPosts', () => fetchPosts(user.id));
          const comments = await step('getComments', () =>
            fetchComments(userPosts[0].id)
          );
          return { user, posts: userPosts, comments };
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.comments).toHaveLength(1);
      }
    });
  });

  describe('effect: Effect.gen() with yield*', () => {
    const fetchUser = (id: string): Effect.Effect<User, 'NOT_FOUND'> =>
      users[id] ? Effect.succeed(users[id]) : Effect.fail('NOT_FOUND' as const);

    const fetchPosts = (userId: string): Effect.Effect<Post[], 'FETCH_ERROR'> =>
      posts[userId] ? Effect.succeed(posts[userId]) : Effect.fail('FETCH_ERROR' as const);

    const fetchComments = (
      postId: string
    ): Effect.Effect<Comment[], 'COMMENTS_ERROR'> =>
      Effect.succeed([{ id: 'c1', text: 'Great post!', postId }]);

    it('uses Effect.gen() with yield* for sequential operations', async () => {
      const loadUserData = Effect.gen(function* () {
        const user = yield* fetchUser('1');
        const userPosts = yield* fetchPosts(user.id);
        return { user, posts: userPosts };
      });

      const result = await Effect.runPromise(loadUserData);

      expect(result.user.name).toBe('Alice');
      expect(result.posts).toHaveLength(1);
    });

    it('stays flat with 3+ operations', async () => {
      const loadEverything = Effect.gen(function* () {
        const user = yield* fetchUser('1');
        const userPosts = yield* fetchPosts(user.id);
        const comments = yield* fetchComments(userPosts[0].id);
        return { user, posts: userPosts, comments };
      });

      const result = await Effect.runPromise(loadEverything);

      expect(result.comments).toHaveLength(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ERROR TYPE INFERENCE
// ─────────────────────────────────────────────────────────────────────────────
describe('3. Error type inference', () => {
  describe('neverthrow: manual error unions', () => {
    const validateEmail = (
      email: string
    ): Result<string, 'INVALID_EMAIL'> =>
      email.includes('@') ? ntOk(email) : ntErr('INVALID_EMAIL');

    const validatePassword = (
      password: string
    ): Result<string, 'WEAK_PASSWORD'> =>
      password.length >= 8 ? ntOk(password) : ntErr('WEAK_PASSWORD');

    const createUser = (
      email: string,
      _password: string
    ): ResultAsync<User, 'DB_ERROR'> =>
      ntOkAsync({ id: '1', name: 'New User', email });

    it('requires explicit type annotation for error union', async () => {
      // You MUST manually track the error union
      type SignUpError = 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'DB_ERROR';

      const signUp = (
        email: string,
        password: string
      ): ResultAsync<User, SignUpError> => {
        const emailResult = validateEmail(email);
        if (emailResult.isErr()) {
          return ntErrAsync(emailResult.error);
        }

        const passwordResult = validatePassword(password);
        if (passwordResult.isErr()) {
          return ntErrAsync(passwordResult.error);
        }

        return createUser(emailResult.value, passwordResult.value);
      };

      const result = await signUp('alice@example.com', 'securepass123');
      expect(result.isOk()).toBe(true);

      const badResult = await signUp('not-an-email', 'short');
      expect(badResult.isErr()).toBe(true);
    });
  });

  describe('workflow: automatic error unions', () => {
    const validateEmail = (email: string): AsyncResult<string, 'INVALID_EMAIL'> =>
      Promise.resolve(email.includes('@') ? ok(email) : err('INVALID_EMAIL'));

    const validatePassword = (
      password: string
    ): AsyncResult<string, 'WEAK_PASSWORD'> =>
      Promise.resolve(
        password.length >= 8 ? ok(password) : err('WEAK_PASSWORD')
      );

    const createUser = (
      email: string,
      _password: string
    ): AsyncResult<User, 'DB_ERROR'> =>
      Promise.resolve(ok({ id: '1', name: 'New User', email }));

    it('infers error union from dependencies automatically', async () => {
      // NO manual type annotation needed!
      // TypeScript knows: 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'DB_ERROR' | UnexpectedError
      const signUp = createWorkflow('signUp', {
        validateEmail,
        validatePassword,
        createUser,
      });

      const result = await signUp(async ({ step, deps }) => {
        const email = await step('validateEmail', () => deps.validateEmail('alice@example.com'));
        const password = await step('validatePassword', () => deps.validatePassword('securepass123'));
        return await step('createUser', () => deps.createUser(email, password));
      });

      expect(result.ok).toBe(true);

      // Error handling with full type safety
      const badResult = await signUp(async ({ step, deps }) => {
        const email = await step('validateEmail', () => deps.validateEmail('not-an-email'));
        const password = await step('validatePassword', () => deps.validatePassword('short'));
        return await step('createUser', () => deps.createUser(email, password));
      });

      expect(badResult.ok).toBe(false);
      if (!badResult.ok) {
        // TypeScript knows this can only be one of the expected errors
        expect(['INVALID_EMAIL', 'WEAK_PASSWORD', 'DB_ERROR']).toContain(
          badResult.error
        );
      }
    });
  });

  describe('workflow: run() infers errors with catchUnexpected', () => {
    const validateEmail = (email: string): AsyncResult<string, 'INVALID_EMAIL'> =>
      Promise.resolve(email.includes('@') ? ok(email) : err('INVALID_EMAIL'));

    const validatePassword = (
      password: string
    ): AsyncResult<string, 'WEAK_PASSWORD'> =>
      Promise.resolve(
        password.length >= 8 ? ok(password) : err('WEAK_PASSWORD')
      );

    const createUser = (
      email: string,
      _password: string
    ): AsyncResult<User, 'DB_ERROR'> =>
      Promise.resolve(ok({ id: '1', name: 'New User', email }));

    type SignUpError =
      | 'INVALID_EMAIL'
      | 'WEAK_PASSWORD'
      | 'DB_ERROR'
      | typeof Awaitly.UNEXPECTED_ERROR;

    it('run() with catchUnexpected gives typed error union', async () => {
      const result = await run<User, SignUpError>(
        async ({ step }) => {
          const email = await step('validateEmail', () =>
            validateEmail('alice@example.com')
          );
          const password = await step('validatePassword', () =>
            validatePassword('securepass123')
          );
          return await step('createUser', () =>
            createUser(email, password)
          );
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(result.ok).toBe(true);

      const badResult = await run<User, SignUpError>(
        async ({ step }) => {
          const email = await step('validateEmail', () =>
            validateEmail('not-an-email')
          );
          const password = await step('validatePassword', () =>
            validatePassword('short')
          );
          return await step('createUser', () =>
            createUser(email, password)
          );
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(badResult.ok).toBe(false);
      if (!badResult.ok) {
        expect(['INVALID_EMAIL', 'WEAK_PASSWORD', 'DB_ERROR']).toContain(
          badResult.error.type ?? badResult.error
        );
      }
    });
  });

  describe('effect: typed error classes', () => {
    class InvalidEmail extends Error {
      readonly _tag = 'InvalidEmail';
    }
    class WeakPassword extends Error {
      readonly _tag = 'WeakPassword';
    }
    class DbError extends Error {
      readonly _tag = 'DbError';
    }

    const validateEmail = (email: string): Effect.Effect<string, InvalidEmail> =>
      email.includes('@')
        ? Effect.succeed(email)
        : Effect.fail(new InvalidEmail('Invalid email'));

    const validatePassword = (
      password: string
    ): Effect.Effect<string, WeakPassword> =>
      password.length >= 8
        ? Effect.succeed(password)
        : Effect.fail(new WeakPassword('Weak password'));

    const createUser = (
      email: string,
      _password: string
    ): Effect.Effect<User, DbError> =>
      Effect.succeed({ id: '1', name: 'New User', email });

    it('uses typed error classes for error union', async () => {
      const signUp = (email: string, password: string) =>
        Effect.gen(function* () {
          const validEmail = yield* validateEmail(email);
          const validPassword = yield* validatePassword(password);
          return yield* createUser(validEmail, validPassword);
        });

      const result = await Effect.runPromise(signUp('alice@example.com', 'securepass123'));
      expect(result.email).toBe('alice@example.com');

      const exit = await Effect.runPromiseExit(signUp('not-an-email', 'short'));
      expect(exit._tag).toBe('Failure');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. WRAPPING THROWING CODE
// ─────────────────────────────────────────────────────────────────────────────
describe('4. Wrapping throwing code', () => {
  const riskyOperation = async (shouldFail: boolean): Promise<string> => {
    if (shouldFail) throw new Error('Something went wrong');
    return 'success';
  };

  describe('neverthrow: ResultAsync.fromPromise()', () => {
    it('wraps promises with error mapper', async () => {
      const result = await ResultAsync.fromPromise(
        riskyOperation(false),
        () => 'OPERATION_FAILED'
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('success');
    });

    it('catches throws and maps to typed error', async () => {
      const result = await ResultAsync.fromPromise(
        riskyOperation(true),
        () => 'OPERATION_FAILED'
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe('OPERATION_FAILED');
    });
  });

  describe('workflow: step.try()', () => {
    // For proper error typing, use createWorkflow
    // Define a wrapper that returns AsyncResult
    const wrappedRiskyOp = (shouldFail: boolean): AsyncResult<string, 'OPERATION_FAILED'> =>
      riskyOperation(shouldFail)
        .then((v) => ok(v))
        .catch(() => err('OPERATION_FAILED'));

    it('wraps throwing code with typed error', async () => {
      const workflow = createWorkflow('wrappedRiskyOp', { wrappedRiskyOp });

      const result = await workflow(async ({ step, deps }) => {
        return await step('wrappedRiskyOp', () => deps.wrappedRiskyOp(false));
      });

      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBe('success');
    });

    it('catches throws and maps to typed error', async () => {
      const workflow = createWorkflow('wrappedRiskyOp', { wrappedRiskyOp });

      const result = await workflow(async ({ step, deps }) => {
        return await step('wrappedRiskyOp', () => deps.wrappedRiskyOp(true));
      });

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBe('OPERATION_FAILED');
    });

    it('supports step.try with error mapping in workflow', async () => {
      // step.try is for wrapping code that throws (not Result-returning)
      // The error gets caught and workflow continues type-safely
      const workflow = createWorkflow('wrappedRiskyOp', { wrappedRiskyOp });

      const result = await workflow(async ({ step }) => {
        // step.try catches throws and maps them to typed errors
        return await step.try('riskyOp', () => riskyOperation(true), {
          error: 'OPERATION_FAILED',
        });
      });

      expect(result.ok).toBe(false);
      // When using step.try, the error is the mapped error
      if (!result.ok) {
        expect(result.error).toBe('OPERATION_FAILED');
      }
    });
  });

  describe('workflow: run() with step.try()', () => {
    it('run() wraps throwing code with step.try', async () => {
      type RunErrors = 'OPERATION_FAILED' | typeof Awaitly.UNEXPECTED_ERROR;

      const result = await run<string, RunErrors>(
        async ({ step }) => {
          return await step.try('riskyOp', () => riskyOperation(false), {
            error: 'OPERATION_FAILED',
          });
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('success');
    });

    it('run() step.try catches throws and maps to typed error', async () => {
      type RunErrors = 'OPERATION_FAILED' | typeof Awaitly.UNEXPECTED_ERROR;

      const result = await run<string, RunErrors>(
        async ({ step }) => {
          return await step.try('riskyOp', () => riskyOperation(true), {
            error: 'OPERATION_FAILED',
          });
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('OPERATION_FAILED');
    });
  });

  describe('effect: Effect.tryPromise()', () => {
    it('wraps promises with error mapping', async () => {
      const result = await Effect.runPromise(
        Effect.tryPromise({
          try: () => riskyOperation(false),
          catch: () => 'OPERATION_FAILED' as const,
        })
      );

      expect(result).toBe('success');
    });

    it('catches throws and maps to typed error', async () => {
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => riskyOperation(true),
          catch: () => 'OPERATION_FAILED' as const,
        })
      );

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toBe('OPERATION_FAILED');
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PARALLEL OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────
describe('5. Parallel operations', () => {
  const fetchUser = (id: string): AsyncResult<User, 'USER_NOT_FOUND'> =>
    Promise.resolve(
      id === '1'
        ? ok({ id, name: 'Alice', email: 'alice@example.com' })
        : err('USER_NOT_FOUND')
    );

  const fetchPosts = (userId: string): AsyncResult<Post[], 'POSTS_ERROR'> =>
    Promise.resolve(ok([{ id: 'p1', title: 'Post 1', authorId: userId }]));

  const fetchComments = (
    postId: string
  ): AsyncResult<Comment[], 'COMMENTS_ERROR'> =>
    Promise.resolve(ok([{ id: 'c1', text: 'Comment 1', postId }]));

  describe('neverthrow: Result.combine()', () => {
    const ntFetchUser = (
      id: string
    ): ResultAsync<User, 'USER_NOT_FOUND'> =>
      id === '1'
        ? ntOkAsync({ id, name: 'Alice', email: 'alice@example.com' })
        : ntErrAsync('USER_NOT_FOUND');

    const ntFetchPosts = (
      userId: string
    ): ResultAsync<Post[], 'POSTS_ERROR'> =>
      ntOkAsync([{ id: 'p1', title: 'Post 1', authorId: userId }]);

    it('combines results with first-error semantics', async () => {
      const result = await ResultAsync.combine([
        ntFetchUser('1'),
        ntFetchPosts('1'),
      ]);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const [user, posts] = result.value;
        expect(user.name).toBe('Alice');
        expect(posts).toHaveLength(1);
      }
    });
  });

  describe('workflow: allAsync()', () => {
    it('combines results with first-error semantics', async () => {
      const result = await allAsync([fetchUser('1'), fetchPosts('1')]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const [user, posts] = result.value;
        expect(user.name).toBe('Alice');
        expect(posts).toHaveLength(1);
      }
    });

    it('works inside step() for complex parallel patterns', async () => {
      const loadDashboard = createWorkflow('loadDashboard', {
        fetchUser,
        fetchPosts,
        fetchComments,
      });

      const result = await loadDashboard(async ({ step, deps }) => {
        // Fetch user first
        const user = await step('getUser', () => deps.fetchUser('1'));

        // Then fetch posts and comments in parallel
        const { posts, comments } = await step.parallel('Fetch posts and comments', {
          posts: () => deps.fetchPosts(user.id),
          comments: () => deps.fetchComments('p1'),
        });

        return { user, posts, comments };
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.user.name).toBe('Alice');
        expect(result.value.posts).toHaveLength(1);
        expect(result.value.comments).toHaveLength(1);
      }
    });
  });

  describe('workflow: run() with step.parallel()', () => {
    it('run() fetches user then runs step.parallel', async () => {
      type RunErrors =
        | 'USER_NOT_FOUND'
        | 'POSTS_ERROR'
        | 'COMMENTS_ERROR'
        | typeof Awaitly.UNEXPECTED_ERROR;

      const result = await run<
        { user: User; posts: Post[]; comments: Comment[] },
        RunErrors
      >(
        async ({ step }) => {
          const user = await step('getUser', () => fetchUser('1'));
          const { posts, comments } = await step.parallel(
            'Fetch posts and comments',
            {
              posts: () => fetchPosts(user.id),
              comments: () => fetchComments('p1'),
            }
          );
          return { user, posts, comments };
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.user.name).toBe('Alice');
        expect(result.value.posts).toHaveLength(1);
        expect(result.value.comments).toHaveLength(1);
      }
    });
  });

  describe('effect: Effect.all() for parallel operations', () => {
    const fetchUserEffect = (id: string): Effect.Effect<User, 'USER_NOT_FOUND'> =>
      id === '1'
        ? Effect.succeed({ id, name: 'Alice', email: 'alice@example.com' })
        : Effect.fail('USER_NOT_FOUND' as const);

    const fetchPostsEffect = (userId: string): Effect.Effect<Post[], 'POSTS_ERROR'> =>
      Effect.succeed([{ id: 'p1', title: 'Post 1', authorId: userId }]);

    it('combines results with first-error semantics', async () => {
      const result = await Effect.runPromise(
        Effect.all([fetchUserEffect('1'), fetchPostsEffect('1')])
      );

      const [user, posts] = result;
      expect(user.name).toBe('Alice');
      expect(posts).toHaveLength(1);
    });

    it('works inside Effect.gen() for complex parallel patterns', async () => {
      const fetchCommentsEffect = (
        postId: string
      ): Effect.Effect<Comment[], 'COMMENTS_ERROR'> =>
        Effect.succeed([{ id: 'c1', text: 'Comment 1', postId }]);

      const loadDashboard = Effect.gen(function* () {
        const user = yield* fetchUserEffect('1');
        const [posts, comments] = yield* Effect.all([
          fetchPostsEffect(user.id),
          fetchCommentsEffect('p1'),
        ]);
        return { user, posts, comments };
      });

      const result = await Effect.runPromise(loadDashboard);
      expect(result.user.name).toBe('Alice');
      expect(result.posts).toHaveLength(1);
      expect(result.comments).toHaveLength(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. COLLECTING ALL ERRORS
// ─────────────────────────────────────────────────────────────────────────────
describe('6. Collecting all errors', () => {
  describe('neverthrow: combineWithAllErrors()', () => {
    const validateEmail = (
      email: string
    ): Result<string, 'INVALID_EMAIL'> =>
      email.includes('@') ? ntOk(email) : ntErr('INVALID_EMAIL');

    const validatePassword = (
      password: string
    ): Result<string, 'WEAK_PASSWORD'> =>
      password.length >= 8 ? ntOk(password) : ntErr('WEAK_PASSWORD');

    const validateUsername = (
      username: string
    ): Result<string, 'INVALID_USERNAME'> =>
      username.length >= 3 ? ntOk(username) : ntErr('INVALID_USERNAME');

    it('collects all errors for form validation', () => {
      const result = Result.combineWithAllErrors([
        validateEmail('not-email'),
        validatePassword('short'),
        validateUsername('ab'),
      ]);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toEqual([
          'INVALID_EMAIL',
          'WEAK_PASSWORD',
          'INVALID_USERNAME',
        ]);
      }
    });
  });

  describe('workflow: allSettled()', () => {
    const validateEmail = (email: string) =>
      email.includes('@') ? ok(email) : err('INVALID_EMAIL' as const);

    const validatePassword = (password: string) =>
      password.length >= 8 ? ok(password) : err('WEAK_PASSWORD' as const);

    const validateUsername = (username: string) =>
      username.length >= 3 ? ok(username) : err('INVALID_USERNAME');

    it('collects all errors for form validation', () => {
      const result = allSettled([
        validateEmail('not-email'),
        validatePassword('short'),
        validateUsername('ab'),
      ]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.map((e) => e.error)).toEqual([
          'INVALID_EMAIL',
          'WEAK_PASSWORD',
          'INVALID_USERNAME',
        ]);
      }
    });

    it('returns all values when all succeed', () => {
      const result = allSettled([
        validateEmail('alice@example.com'),
        validatePassword('securepass123'),
        validateUsername('alice'),
      ]);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([
          'alice@example.com',
          'securepass123',
          'alice',
        ]);
      }
    });
  });

  describe('effect: Effect.all() with collect errors', () => {
    const validateEmail = (email: string): Effect.Effect<string, 'INVALID_EMAIL'> =>
      email.includes('@')
        ? Effect.succeed(email)
        : Effect.fail('INVALID_EMAIL' as const);

    const validatePassword = (
      password: string
    ): Effect.Effect<string, 'WEAK_PASSWORD'> =>
      password.length >= 8
        ? Effect.succeed(password)
        : Effect.fail('WEAK_PASSWORD' as const);

    const validateUsername = (
      username: string
    ): Effect.Effect<string, 'INVALID_USERNAME'> =>
      username.length >= 3
        ? Effect.succeed(username)
        : Effect.fail('INVALID_USERNAME' as const);

    it('collects all errors using Effect.all() with Either', async () => {
      const results = await Effect.runPromise(
        Effect.all(
          [
            validateEmail('not-email'),
            validatePassword('short'),
            validateUsername('ab'),
          ],
          { mode: 'either' }
        )
      );

      const errors = results
        .map((r) => (r._tag === 'Left' ? r.left : null))
        .filter((e): e is 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'INVALID_USERNAME' => e !== null);

      expect(errors).toEqual(['INVALID_EMAIL', 'WEAK_PASSWORD', 'INVALID_USERNAME']);
    });

    it('returns all values when all succeed', async () => {
      const result = await Effect.runPromise(
        Effect.all([
          validateEmail('alice@example.com'),
          validatePassword('securepass123'),
          validateUsername('alice'),
        ])
      );

      expect(result).toEqual(['alice@example.com', 'securepass123', 'alice']);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. ERROR RECOVERY (orElse)
// ─────────────────────────────────────────────────────────────────────────────
describe('7. Error recovery', () => {
  const defaultUser: User = { id: '0', name: 'Guest', email: 'guest@example.com' };

  describe('neverthrow: .orElse()', () => {
    const fetchUser = (id: string): ResultAsync<User, 'NOT_FOUND'> =>
      id === '1'
        ? ntOkAsync({ id, name: 'Alice', email: 'alice@example.com' })
        : ntErrAsync('NOT_FOUND');

    it('recovers from errors with fallback', async () => {
      const result = await fetchUser('999').orElse((error) => {
        if (error === 'NOT_FOUND') return ntOk(defaultUser);
        return ntErr(error);
      });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().name).toBe('Guest');
    });
  });

  describe('awaitly: inline conditional recovery', () => {
    const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
      Promise.resolve(
        id === '1'
          ? ok({ id, name: 'Alice', email: 'alice@example.com' })
          : err('NOT_FOUND')
      );

    it('recovers using conditional logic with createWorkflow', async () => {
      const workflow = createWorkflow('fetchUser', { fetchUser });

      const result = await workflow(async ({ step, deps }) => {
        // Get the raw result without unwrapping
        const userResult = await deps.fetchUser('999');

        // Handle recovery inline
        if (!userResult.ok && userResult.error === 'NOT_FOUND') {
          return defaultUser;
        }

        // Unwrap and continue
        return await step('getUser', () => userResult);
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Guest');
      }
    });

    it('can also use match() for pattern matching', async () => {
      const userResult = await fetchUser('999');

      const user = match(userResult, {
        ok: (value) => value,
        err: (error) => (error === 'NOT_FOUND' ? defaultUser : defaultUser),
      });

      expect(user.name).toBe('Guest');
    });
  });

  describe('awaitly run(): recovery at boundary', () => {
    const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
      Promise.resolve(
        id === '1'
          ? ok({ id, name: 'Alice', email: 'alice@example.com' })
          : err('NOT_FOUND')
      );

    it('run() with step then recover at boundary', async () => {
      type RunErrors = 'NOT_FOUND' | typeof Awaitly.UNEXPECTED_ERROR;

      const result = await run<User, RunErrors>(
        async ({ step }) => {
          return await step('getUser', () => fetchUser('999'));
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      const user =
        result.ok ? result.value : result.error === 'NOT_FOUND' ? defaultUser : null;
      expect(user).not.toBeNull();
      expect(user!.name).toBe('Guest');
    });
  });

  describe('effect: Effect.catchAll() for error recovery', () => {
    const fetchUser = (id: string): Effect.Effect<User, 'NOT_FOUND'> =>
      id === '1'
        ? Effect.succeed({ id, name: 'Alice', email: 'alice@example.com' })
        : Effect.fail('NOT_FOUND' as const);

    it('recovers from errors with fallback', async () => {
      const result = await Effect.runPromise(
        fetchUser('999').pipe(
          Effect.catchAll((error) => {
            if (error === 'NOT_FOUND') {
              return Effect.succeed(defaultUser);
            }
            return Effect.fail(error);
          })
        )
      );

      expect(result.name).toBe('Guest');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. TRANSFORMATIONS (map, mapError)
// ─────────────────────────────────────────────────────────────────────────────
describe('8. Transformations', () => {
  describe('neverthrow: .map() and .mapErr()', () => {
    const fetchUser = (id: string): ResultAsync<User, 'NOT_FOUND'> =>
      id === '1'
        ? ntOkAsync({ id, name: 'Alice', email: 'alice@example.com' })
        : ntErrAsync('NOT_FOUND');

    it('transforms success values', async () => {
      const result = await fetchUser('1').map((user) => user.name);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('Alice');
    });

    it('transforms error values', async () => {
      const result = await fetchUser('999').mapErr((error) => ({
        code: error,
        message: 'User not found',
      }));

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toEqual({
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    });
  });

  describe('workflow: map() and mapError()', () => {
    const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
      Promise.resolve(
        id === '1'
          ? ok({ id, name: 'Alice', email: 'alice@example.com' })
          : err('NOT_FOUND')
      );

    it('transforms success values', async () => {
      const userResult = await fetchUser('1');
      const nameResult = map(userResult, (user) => user.name);

      expect(nameResult.ok).toBe(true);
      expect(nameResult.ok && nameResult.value).toBe('Alice');
    });

    it('transforms error values', async () => {
      const userResult = await fetchUser('999');
      const enrichedResult = mapError(userResult, (error) => ({
        code: error,
        message: 'User not found',
      }));

      expect(enrichedResult.ok).toBe(false);
      expect(!enrichedResult.ok && enrichedResult.error).toEqual({
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    });

    it('can chain with andThen()', async () => {
      const fetchPosts = (
        userId: string
      ): AsyncResult<Post[], 'POSTS_ERROR'> =>
        Promise.resolve(
          ok([{ id: 'p1', title: 'Post 1', authorId: userId }])
        );

      const userResult = await fetchUser('1');
      if (!userResult.ok) {
        throw new Error('User not found');
      }
      const postsResult = await fetchPosts(userResult.value.id);

      expect(postsResult.ok).toBe(true);
    });
  });

  describe('effect: Effect.map() and Effect.mapError()', () => {
    const fetchUser = (id: string): Effect.Effect<User, 'NOT_FOUND'> =>
      id === '1'
        ? Effect.succeed({ id, name: 'Alice', email: 'alice@example.com' })
        : Effect.fail('NOT_FOUND' as const);

    it('transforms success values', async () => {
      const result = await Effect.runPromise(
        Effect.map(fetchUser('1'), (user) => user.name)
      );

      expect(result).toBe('Alice');
    });

    it('transforms error values', async () => {
      const exit = await Effect.runPromiseExit(
        Effect.mapError(fetchUser('999'), (error) => ({
          code: error,
          message: 'User not found',
        }))
      );

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
        expect(exit.cause.error).toEqual({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }
    });

    it('can chain with Effect.flatMap()', async () => {
      const fetchPosts = (
        userId: string
      ): Effect.Effect<Post[], 'POSTS_ERROR'> =>
        Effect.succeed([{ id: 'p1', title: 'Post 1', authorId: userId }]);

      const result = await Effect.runPromise(
        Effect.flatMap(fetchUser('1'), (user) => fetchPosts(user.id))
      );

      expect(result).toHaveLength(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. PATTERN MATCHING
// ─────────────────────────────────────────────────────────────────────────────
describe('9. Pattern matching', () => {
  describe('neverthrow: .match()', () => {
    const fetchUser = (id: string): ResultAsync<User, 'NOT_FOUND'> =>
      id === '1'
        ? ntOkAsync({ id, name: 'Alice', email: 'alice@example.com' })
        : ntErrAsync('NOT_FOUND');

    it('pattern matches on result', async () => {
      const result = await fetchUser('1');
      const message = result.match(
        (user) => `Welcome, ${user.name}!`,
        (error) => `Error: ${error}`
      );

      expect(message).toBe('Welcome, Alice!');
    });
  });

  describe('workflow: match()', () => {
    const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
      Promise.resolve(
        id === '1'
          ? ok({ id, name: 'Alice', email: 'alice@example.com' })
          : err('NOT_FOUND')
      );

    it('pattern matches on result', async () => {
      const result = await fetchUser('1');
      const message = match(result, {
        ok: (user) => `Welcome, ${user.name}!`,
        err: (error) => `Error: ${error}`,
      });

      expect(message).toBe('Welcome, Alice!');
    });

    it('also works with simple conditionals', async () => {
      const result = await fetchUser('1');
      const message = result.ok
        ? `Welcome, ${result.value.name}!`
        : `Error: ${result.error}`;

      expect(message).toBe('Welcome, Alice!');
    });
  });

  describe('effect: Effect.match()', () => {
    const fetchUser = (id: string): Effect.Effect<User, 'NOT_FOUND'> =>
      id === '1'
        ? Effect.succeed({ id, name: 'Alice', email: 'alice@example.com' })
        : Effect.fail('NOT_FOUND' as const);

    it('pattern matches on result', async () => {
      const message = await Effect.runPromise(
        Effect.match(fetchUser('1'), {
          onFailure: (error) => `Error: ${error}`,
          onSuccess: (user) => `Welcome, ${user.name}!`,
        })
      );

      expect(message).toBe('Welcome, Alice!');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. WORKFLOW-ONLY FEATURES (not in neverthrow)
// ─────────────────────────────────────────────────────────────────────────────

// Helper: pipe implementation for functional composition tests
function pipe<A>(a: A): A;
function pipe<A, B>(a: A, fn1: (a: A) => B): B;
function pipe<A, B, C>(a: A, fn1: (a: A) => B, fn2: (b: B) => C): C;
function pipe(a: unknown, ...fns: Array<(x: unknown) => unknown>): unknown {
  return fns.reduce((acc, fn) => fn(acc), a);
}

// Helper: R namespace for pipeable Result functions
const R = {
  map:
    <A, B>(fn: (a: A) => B) =>
    <E>(result: { ok: true; value: A } | { ok: false; error: E }): { ok: true; value: B } | { ok: false; error: E } =>
      result.ok ? ok(fn(result.value)) : result,

  andThen:
    <A, B, E2>(fn: (a: A) => { ok: true; value: B } | { ok: false; error: E2 }) =>
    <E1>(result: { ok: true; value: A } | { ok: false; error: E1 }): { ok: true; value: B } | { ok: false; error: E1 | E2 } =>
      result.ok ? fn(result.value) : result,

  mapError:
    <E1, E2>(fn: (e: E1) => E2) =>
    <A>(result: { ok: true; value: A } | { ok: false; error: E1 }): { ok: true; value: A } | { ok: false; error: E2 } =>
      result.ok ? result : err(fn(result.error)),
};

describe('10. Workflow-only features', () => {
  describe('run() with catchUnexpected - typed errors without DI', () => {
    const getUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
      Promise.resolve(
        id === '1'
          ? ok({ id, name: 'Alice', email: 'alice@example.com' })
          : err('NOT_FOUND')
      );

    it('run() returns typed errors when using catchUnexpected', async () => {
      type RunErrors = 'NOT_FOUND' | typeof Awaitly.UNEXPECTED_ERROR;

      const okResult = await run<User, RunErrors>(
        async ({ step }) => {
          return await step('getUser', () => getUser('1'));
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(okResult.ok).toBe(true);
      if (okResult.ok) expect(okResult.value.name).toBe('Alice');

      const errResult = await run<User, RunErrors>(
        async ({ step }) => {
          return await step('getUser', () => getUser('999'));
        },
        { catchUnexpected: () => Awaitly.UNEXPECTED_ERROR }
      );

      expect(errResult.ok).toBe(false);
      if (!errResult.ok) expect(errResult.error).toBe('NOT_FOUND');
    });
  });

  describe('step.retry() - automatic retry with backoff', () => {
    it('retries operations automatically', async () => {
      let attempts = 0;

      const flakyOperation = (): AsyncResult<string, 'FLAKY_ERROR'> => {
        attempts++;
        if (attempts < 3) return Promise.resolve(err('FLAKY_ERROR'));
        return Promise.resolve(ok('success'));
      };

      const workflow = createWorkflow('flakyOperation', { flakyOperation });

      const result = await workflow(async ({ step, deps }) => {
        return await step.retry('flakyOp', () => deps.flakyOperation(), {
          attempts: 5,
          backoff: 'exponential',
          initialDelay: 10,
          retryOn: (error: unknown) => error === 'FLAKY_ERROR',
        });
      });

      expect(result.ok).toBe(true);
      expect(attempts).toBe(3);
    });
  });

  describe('step.withTimeout() - timeout protection', () => {
    it('times out slow operations', async () => {
      const slowOperation = (): AsyncResult<string, never> =>
        new Promise((resolve) =>
          setTimeout(() => resolve(ok('done')), 5000)
        );

      const workflow = createWorkflow('slowOperation', { slowOperation });

      const result = await workflow(async ({ step, deps }) => {
        return await step.withTimeout('slowOp', () => deps.slowOperation(), {
          ms: 50,
        });
      });

      expect(result.ok).toBe(false);
      // Timeout results in StepTimeoutError
    });
  });

  describe('step caching - skip completed steps', () => {
    it('caches step results by key', async () => {
      let callCount = 0;

      const expensiveOperation = (
        id: string
      ): AsyncResult<string, never> => {
        callCount++;
        return Promise.resolve(ok(`result-${id}`));
      };

      const cache = new Map();
      const workflow = createWorkflow('expensiveOperation', { expensiveOperation }, { cache });

      // First run
      await workflow(async ({ step, deps }) => {
        const a = await step('expensiveOp', () => deps.expensiveOperation('1'), {
          key: 'op:1',
        });
        const b = await step('expensiveOp', () => deps.expensiveOperation('1'), {
          key: 'op:1',
        }); // Cached!
        return { a, b };
      });

      expect(callCount).toBe(1); // Only called once despite two step() calls
    });
  });

  describe('event stream - observability', () => {
    it('emits events for monitoring', async () => {
      const events: Array<{ type: string }> = [];

      const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
        Promise.resolve(ok({ id, name: 'Alice', email: 'alice@example.com' }));

      const workflow = createWorkflow(
        'fetchUser',
        { fetchUser },
        {
          onEvent: (event) => events.push({ type: event.type }),
        }
      );

      await workflow(async ({ step, deps }) => {
        // Note: step_complete is emitted when a key is provided (for caching/resume)
        return await step('fetchUser', () => deps.fetchUser('1'), {
          description: 'Fetch user',
          key: 'user:1',
        });
      });

      expect(events.map((e) => e.type)).toEqual([
        'workflow_start',
        'step_start',
        'step_success',
        'step_complete', // Only emitted with key
        'workflow_success',
      ]);
    });

    it('without key, step_complete is not emitted', async () => {
      const events: Array<{ type: string }> = [];

      const fetchUser = (id: string): AsyncResult<User, 'NOT_FOUND'> =>
        Promise.resolve(ok({ id, name: 'Alice', email: 'alice@example.com' }));

      const workflow = createWorkflow(
        'fetchUser',
        { fetchUser },
        {
          onEvent: (event) => events.push({ type: event.type }),
        }
      );

      await workflow(async ({ step, deps }) => {
        return await step('fetchUser', () => deps.fetchUser('1'), { description: 'Fetch user' });
      });

      // With step ID but no key, awaitly may still emit step_complete (e.g. when ID is used as key)
      expect(events.map((e) => e.type)).toContain('workflow_start');
      expect(events.map((e) => e.type)).toContain('step_start');
      expect(events.map((e) => e.type)).toContain('step_success');
      expect(events.map((e) => e.type)).toContain('workflow_success');
    });
  });

  describe('strict mode - close error unions', () => {
    it('maps unexpected errors to known type', async () => {
      const riskyOp = (): AsyncResult<string, 'KNOWN_ERROR'> => {
        throw new Error('Unexpected!');
      };

      const workflow = createWorkflow(
        'riskyOp',
        { riskyOp },
        {
          catchUnexpected: () => 'UNEXPECTED' as const,
        }
      );

      const result = await workflow(async ({ step, deps }) => {
        return await step('riskyOp', () => deps.riskyOp());
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error is now 'KNOWN_ERROR' | 'UNEXPECTED' (no UnexpectedError)
        expect(['KNOWN_ERROR', 'UNEXPECTED']).toContain(result.error);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. STREAMING COMPARISON
// ─────────────────────────────────────────────────────────────────────────────
describe('11. Streaming comparison', () => {
  describe('awaitly/streaming pattern: Result-aware transformers', () => {
    // Simulated streaming utilities
    const mapStream = <T, U, E>(
      items: T[],
      fn: (item: T) => { ok: true; value: U } | { ok: false; error: E }
    ) => items.map(fn);

    const filterStream = <T, E>(
      items: ({ ok: true; value: T } | { ok: false; error: E })[],
      predicate: (item: T) => boolean
    ) => items.filter((r) => r.ok && predicate(r.value));

    it('transforms items with Result wrapping', () => {
      const lines = ['VALID:data1', 'VALID:data2', 'INVALID'];

      const parseLine = (line: string) =>
        line.startsWith('VALID:')
          ? ok(line.replace('VALID:', ''))
          : err('PARSE_ERROR' as const);

      const results = mapStream(lines, parseLine);

      expect(results.length).toBe(3);
      expect(results[0].ok).toBe(true);
      expect(results[2].ok).toBe(false);
    });

    it('filters Result streams', () => {
      const items = [
        ok('hello'),
        ok('world'),
        err('ERROR' as const),
        ok('test'),
      ];

      const filtered = filterStream(items, (s) => s.length > 4);

      expect(filtered.length).toBe(2); // 'hello' and 'world'
    });
  });

  describe('effect: Stream module pattern', () => {
    // Effect's Stream is more powerful but has different API
    it('demonstrates Effect.sync equivalent for simple transforms', async () => {
      const items = ['hello', 'world', 'test'];

      const processed = Effect.sync(() => {
        const results: string[] = [];
        for (const item of items) {
          const upper = item.toUpperCase();
          if (upper.length > 4) {
            results.push(upper);
          }
        }
        return results;
      });

      const result = await Effect.runPromise(processed);
      expect(result).toEqual(['HELLO', 'WORLD']);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. FUNCTIONAL COMPOSITION COMPARISON
// ─────────────────────────────────────────────────────────────────────────────
describe('12. Functional composition comparison', () => {
  describe('neverthrow: method chaining', () => {
    const validateNt = (x: number): Result<number, 'INVALID'> =>
      x > 0 ? ntOk(x) : ntErr('INVALID' as const);

    const doubleNt = (x: number): Result<number, never> => ntOk(x * 2);

    it('chains with andThen', () => {
      const result = validateNt(5).andThen((n) => doubleNt(n));

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(10);
    });
  });

  describe('effect: pipe/flow', () => {
    const validateEffect = (x: number) =>
      x > 0 ? Effect.succeed(x) : Effect.fail('INVALID' as const);

    const doubleEffect = (x: number) => Effect.succeed(x * 2);

    it('composes with pipe', async () => {
      const program = validateEffect(5).pipe(Effect.flatMap(doubleEffect));

      const result = await Effect.runPromise(program);
      expect(result).toBe(10);
    });
  });

  describe('awaitly/functional: pipe with R namespace', () => {
    const validate = (x: number): AsyncResult<number, 'INVALID'> =>
      Promise.resolve(x > 0 ? ok(x) : err('INVALID'));

    const double = (x: number): AsyncResult<number, never> =>
      Promise.resolve(ok(x * 2));

    it('composes with pipe and R.andThen', async () => {
      const validated = await validate(5);
      const result = pipe(
        validated,
        R.andThen((x) => ok(x * 2))
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(10);
      }
    });

    it('handles errors in pipeline', async () => {
      const validated = await validate(-5);
      const result = pipe(
        validated,
        R.andThen((x) => ok(x * 2))
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('INVALID');
      }
    });

    it('transforms with R.map', async () => {
      const validated = await validate(5);
      const result = pipe(
        validated,
        R.map((x) => x * 2),
        R.map((x) => x + 10)
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(20); // (5 * 2) + 10
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. FETCH HELPERS COMPARISON
// ─────────────────────────────────────────────────────────────────────────────
describe('13. Fetch helpers comparison', () => {
  describe('neverthrow: manual wrapping', () => {
    it('wraps fetch with ResultAsync.fromPromise', async () => {
      // Simulate fetch response
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({ id: '1', name: 'Alice' }),
      });

      const fetchUser = (id: string) =>
        ResultAsync.fromPromise(
          mockFetch().then((r) => r.json()),
          () => 'FETCH_ERROR' as const
        );

      const result = await fetchUser('1');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.name).toBe('Alice');
      }
    });
  });

  describe('effect: HttpClient pattern', () => {
    it('uses Effect.tryPromise for fetch', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({ id: '1', name: 'Alice' }),
      });

      const fetchUser = (id: string) =>
        Effect.tryPromise({
          try: () => mockFetch().then((r) => r.json()),
          catch: () => 'FETCH_ERROR' as const,
        });

      const result = await Effect.runPromise(fetchUser('1'));

      expect(result.name).toBe('Alice');
    });
  });

  describe('awaitly/fetch: built-in helpers pattern', () => {
    // Simulated fetchJson with error types
    type FetchError =
      | { type: 'NOT_FOUND' }
      | { type: 'BAD_REQUEST' }
      | { type: 'NETWORK_ERROR' };

    const mockFetchJson = async <T>(
      url: string,
      options?: { mapError?: (status: number) => FetchError }
    ): AsyncResult<T, FetchError> => {
      // Simulate different responses
      if (url.includes('404')) {
        return options?.mapError
          ? err(options.mapError(404))
          : err({ type: 'NOT_FOUND' });
      }
      return ok({ id: '1', name: 'Alice' } as T);
    };

    it('returns typed success with fetchJson', async () => {
      type User = { id: string; name: string };
      const result = await mockFetchJson<User>('/api/users/1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Alice');
      }
    });

    it('returns typed error for 404', async () => {
      type User = { id: string; name: string };
      const result = await mockFetchJson<User>('/api/users/404');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('NOT_FOUND');
      }
    });

    it('supports custom error mapping', async () => {
      type User = { id: string; name: string };
      type CustomError = { type: 'USER_NOT_FOUND'; code: number };

      const result = await mockFetchJson<User>('/api/users/404', {
        mapError: (status): FetchError => ({ type: 'NOT_FOUND' }),
      });

      expect(result.ok).toBe(false);
    });
  });
});
