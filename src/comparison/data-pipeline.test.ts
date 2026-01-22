/**
 * Real-World Scenario: Data Pipeline with Retries and Caching
 * 
 * This scenario demonstrates:
 * - Automatic retry with exponential backoff
 * - Step caching to avoid duplicate API calls
 * - Timeout protection
 * - Event stream for observability
 * - Resume state for long-running processes
 * 
 * Compare implementations across workflow, neverthrow, and effect.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResultAsync } from 'neverthrow';
import { Effect, Schedule, Duration } from 'effect';
import {
  ok,
  err,
  allAsync,
  tryAsync,
  isPromiseRejectedError,
  type AsyncResult,
  type UnexpectedError,
} from 'awaitly';
import {
  createWorkflow,
  isStepComplete,
  type ResumeStateEntry,
} from 'awaitly/workflow';

// ============================================================================
// Shared Types
// ============================================================================

type UserId = string;
type User = { id: UserId; name: string; email: string };
type Post = { id: string; userId: UserId; title: string; content: string };
type Comment = { id: string; postId: string; userId: UserId; text: string };
type Analytics = { userId: UserId; postsCount: number; commentsCount: number };

type FetchError = 'USER_NOT_FOUND' | 'POSTS_FETCH_FAILED' | 'COMMENTS_FETCH_FAILED';
type ProcessError = 'ANALYTICS_FAILED';

// ============================================================================
// Shared Dependencies (simulating slow/unreliable APIs)
// ============================================================================

let apiCallCount = 0;

// Shared implementation that all libraries use
const fetchUserImpl = async (userId: UserId): Promise<User> => {
  apiCallCount++;
  await new Promise(resolve => setTimeout(resolve, 50));
  
  if (userId === 'fail-user') {
    throw new Error('USER_NOT_FOUND');
  }
  
  return { id: userId, name: `User ${userId}`, email: `${userId}@example.com` };
};

const fetchPostsImpl = async (userId: UserId): Promise<Post[]> => {
  apiCallCount++;
  await new Promise(resolve => setTimeout(resolve, 100));
  
  if (userId === 'fail-posts') {
    throw new Error('POSTS_FETCH_FAILED');
  }
  
  return [
    { id: 'post-1', userId, title: 'Post 1', content: 'Content 1' },
    { id: 'post-2', userId, title: 'Post 2', content: 'Content 2' },
  ];
};

const fetchCommentsImpl = async (postId: string): Promise<Comment[]> => {
  apiCallCount++;
  await new Promise(resolve => setTimeout(resolve, 80));
  
  if (postId === 'fail-comments') {
    throw new Error('COMMENTS_FETCH_FAILED');
  }
  
  return [
    { id: 'comment-1', postId, userId: 'user-1', text: 'Comment 1' },
  ];
};

const processAnalyticsImpl = async (
  user: User,
  posts: Post[],
  allComments: Comment[]
): Promise<Analytics> => {
  await new Promise(resolve => setTimeout(resolve, 30));
  
  return {
    userId: user.id,
    postsCount: posts.length,
    commentsCount: allComments.length,
  };
};

// ============================================================================
// Workflow Implementation
// ============================================================================

const fetchUser = (userId: UserId): AsyncResult<User, FetchError> =>
  tryAsync(
    async () => await fetchUserImpl(userId),
    () => 'USER_NOT_FOUND'
  );

const fetchPosts = (userId: UserId): AsyncResult<Post[], FetchError> =>
  tryAsync(
    async () => await fetchPostsImpl(userId),
    () => 'POSTS_FETCH_FAILED'
  );

const fetchComments = (postId: string): AsyncResult<Comment[], FetchError> =>
  tryAsync(
    async () => await fetchCommentsImpl(postId),
    () => 'COMMENTS_FETCH_FAILED'
  );

const processAnalytics = (
  user: User,
  posts: Post[],
  comments: Comment[]
): AsyncResult<Analytics, ProcessError> =>
  tryAsync(
    async () => await processAnalyticsImpl(user, posts, comments),
    () => 'ANALYTICS_FAILED'
  );

export async function dataPipelineWorkflow(
  userId: UserId,
  options?: {
    cache?: Map<string, any>;
    onEvent?: (event: any) => void;
    resumeState?: { steps: Map<string, ResumeStateEntry> };
  }
): AsyncResult<Analytics, FetchError | ProcessError | UnexpectedError> {
  const workflow = createWorkflow({ fetchUser, fetchPosts, fetchComments, processAnalytics }, {
    cache: options?.cache,
    onEvent: options?.onEvent,
    resumeState: options?.resumeState,
  });

  return workflow(async (step) => {
    const user = await step(
      () => fetchUser(userId),
      {
        name: 'Fetch user',
        key: `user:${userId}`,
      }
    );

    const posts = await step(
      () => fetchPosts(userId),
      {
        name: 'Fetch posts',
        key: `posts:${userId}`,
      }
    );

    const commentResults = await step.fromResult(
      () => allAsync(posts.map(post => fetchComments(post.id))),
      {
        onError: (error): FetchError => {
          // Since fetchComments uses tryAsync, PromiseRejectedError shouldn't occur
          if (isPromiseRejectedError(error)) {
            return 'COMMENTS_FETCH_FAILED';
          }
          return error;
        },
        name: 'Fetch all comments',
        key: `comments:${userId}`,
      }
    );
    const allComments = commentResults.flat();

    const analytics = await step(
      () => processAnalytics(user, posts, allComments),
      {
        name: 'Process analytics',
        key: `analytics:${userId}`,
      }
    );

    return analytics;
  });
}

// ============================================================================
// Neverthrow Implementation
// ============================================================================

const fetchUserNt = (userId: UserId): ResultAsync<User, FetchError> =>
  ResultAsync.fromPromise(
    fetchUserImpl(userId),
    () => 'USER_NOT_FOUND' as const
  );

const fetchPostsNt = (userId: UserId): ResultAsync<Post[], FetchError> =>
  ResultAsync.fromPromise(
    fetchPostsImpl(userId),
    () => 'POSTS_FETCH_FAILED' as const
  );

const fetchCommentsNt = (postId: string): ResultAsync<Comment[], FetchError> =>
  ResultAsync.fromPromise(
    fetchCommentsImpl(postId),
    () => 'COMMENTS_FETCH_FAILED' as const
  );

const processAnalyticsNt = (
  user: User,
  posts: Post[],
  allComments: Comment[]
): ResultAsync<Analytics, ProcessError> =>
  ResultAsync.fromPromise(
    processAnalyticsImpl(user, posts, allComments),
    () => 'ANALYTICS_FAILED' as const
  );

export function dataPipelineNeverthrow(
  userId: UserId
): ResultAsync<Analytics, FetchError | ProcessError> {
  return fetchUserNt(userId).andThen((user) =>
    fetchPostsNt(userId).andThen((posts) =>
      ResultAsync.combine(posts.map(post => fetchCommentsNt(post.id)))
        .map((commentArrays) => commentArrays.flat())
        .andThen((allComments) => processAnalyticsNt(user, posts, allComments))
    )
  );
}

// ============================================================================
// Effect Implementation
// ============================================================================

const retryPolicy = Schedule.exponential(Duration.millis(50)).pipe(
  Schedule.jittered,
  Schedule.upTo(Duration.seconds(1)),
  Schedule.intersect(Schedule.recurs(2))
);

const fetchUserEffect = (userId: UserId): Effect.Effect<User, FetchError> =>
  Effect.tryPromise({
    try: () => fetchUserImpl(userId),
    catch: () => 'USER_NOT_FOUND' as const,
  });

const fetchPostsEffect = (userId: UserId): Effect.Effect<Post[], FetchError> =>
  Effect.tryPromise({
    try: () => fetchPostsImpl(userId),
    catch: () => 'POSTS_FETCH_FAILED' as const,
  }).pipe(
    Effect.timeoutFail({
      duration: 200,
      onTimeout: () => 'POSTS_FETCH_FAILED' as const,
    }),
    Effect.retry(
      retryPolicy.pipe(
        Schedule.whileInput((error: FetchError) => error === 'POSTS_FETCH_FAILED')
      )
    )
  );

const fetchCommentsEffect = (postId: string): Effect.Effect<Comment[], FetchError> =>
  Effect.tryPromise({
    try: () => fetchCommentsImpl(postId),
    catch: () => 'COMMENTS_FETCH_FAILED' as const,
  }).pipe(
    Effect.timeoutFail({
      duration: 200,
      onTimeout: () => 'COMMENTS_FETCH_FAILED' as const,
    }),
    Effect.retry(
      retryPolicy.pipe(
        Schedule.whileInput((error: FetchError) => error === 'COMMENTS_FETCH_FAILED')
      )
    )
  );

const processAnalyticsEffect = (
  user: User,
  posts: Post[],
  allComments: Comment[]
): Effect.Effect<Analytics, ProcessError> =>
  Effect.tryPromise({
    try: () => processAnalyticsImpl(user, posts, allComments),
    catch: () => 'ANALYTICS_FAILED' as const,
  }).pipe(
    Effect.timeoutFail({
      duration: 150,
      onTimeout: () => 'ANALYTICS_FAILED' as const,
    }),
    Effect.retry(
      retryPolicy.pipe(
        Schedule.whileInput((error: ProcessError) => error === 'ANALYTICS_FAILED')
      )
    )
  );

export const dataPipelineEffect = (userId: UserId): Effect.Effect<Analytics, FetchError | ProcessError> =>
  Effect.gen(function* () {
    const user = yield* fetchUserEffect(userId);
    const posts = yield* fetchPostsEffect(userId);
    const commentArrays = yield* Effect.all(
      posts.map(post => fetchCommentsEffect(post.id)),
      { concurrency: 'unbounded' }
    );
    const allComments = commentArrays.flat();
    return yield* processAnalyticsEffect(user, posts, allComments);
  });

// ============================================================================
// Tests
// ============================================================================

describe('Data Pipeline', () => {
  beforeEach(() => {
    apiCallCount = 0;
  });

  describe('Workflow', () => {
    it('successfully processes data pipeline', async () => {
      const result = await dataPipelineWorkflow('user-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('user-1');
        expect(result.value.postsCount).toBe(2);
        expect(result.value.commentsCount).toBe(2);
      }
    });

    it('uses step caching to avoid duplicate API calls', async () => {
      const cache = new Map();

      const result1 = await dataPipelineWorkflow('user-1', { cache });
      expect(result1.ok).toBe(true);
      const firstCallCount = apiCallCount;

      apiCallCount = 0;
      const result2 = await dataPipelineWorkflow('user-1', { cache });
      expect(result2.ok).toBe(true);

      expect(apiCallCount).toBeLessThan(firstCallCount);
    });

    it('captures events for observability', async () => {
      const events: string[] = [];

      await dataPipelineWorkflow('user-1', {
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(events).toContain('workflow_start');
      expect(events).toContain('step_start');
      expect(events).toContain('step_success');
      expect(events).toContain('workflow_success');
    });

    it('supports resume state for long-running processes', async () => {
      const savedSteps = new Map<string, ResumeStateEntry>();

      await dataPipelineWorkflow('user-1', {
        onEvent: (event) => {
          if (isStepComplete(event) && event.stepKey) {
            savedSteps.set(event.stepKey, {
              result: event.result,
              meta: event.meta,
            });
          }
        },
      });

      expect(savedSteps.size).toBeGreaterThan(0);

      apiCallCount = 0;
      const result = await dataPipelineWorkflow('user-1', {
        resumeState: { steps: savedSteps },
      });

      expect(result.ok).toBe(true);
      expect(apiCallCount).toBeLessThan(5);
    });

    it('demonstrates automatic error type inference', async () => {
      const result = await dataPipelineWorkflow('fail-user');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        if (typeof result.error === 'string') {
          expect(['USER_NOT_FOUND', 'POSTS_FETCH_FAILED', 'COMMENTS_FETCH_FAILED', 'ANALYTICS_FAILED']).toContain(
            result.error
          );
        } else {
          expect(result.error.type).toBe('UNEXPECTED_ERROR');
        }
      }
    });
  });

  describe('Neverthrow', () => {
    it('successfully processes data pipeline', async () => {
      const result = await dataPipelineNeverthrow('user-1');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.userId).toBe('user-1');
        expect(result.value.postsCount).toBe(2);
        expect(result.value.commentsCount).toBe(2);
      }
    });

    it('handles errors with explicit error union', async () => {
      const result = await dataPipelineNeverthrow('fail-user');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(['USER_NOT_FOUND', 'POSTS_FETCH_FAILED', 'COMMENTS_FETCH_FAILED', 'ANALYTICS_FAILED']).toContain(result.error);
      }
    });

    it('chains operations with andThen', async () => {
      const result = await dataPipelineNeverthrow('user-1');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.postsCount).toBeGreaterThan(0);
      }
    });
  });

  describe('Effect', () => {
    it('successfully processes data pipeline', async () => {
      const result = await Effect.runPromise(dataPipelineEffect('user-1'));

      expect(result.userId).toBe('user-1');
      expect(result.postsCount).toBe(2);
      expect(result.commentsCount).toBe(2);
    });

    it('handles errors with typed errors', async () => {
      const exit = await Effect.runPromiseExit(dataPipelineEffect('fail-user'));

      expect(exit._tag).toBe('Failure');
      if (exit._tag === 'Failure') {
        expect(exit.cause._tag).toBe('Fail');
        if (exit.cause._tag === 'Fail') {
          expect(['USER_NOT_FOUND', 'POSTS_FETCH_FAILED', 'COMMENTS_FETCH_FAILED', 'ANALYTICS_FAILED']).toContain(exit.cause.error);
        }
      }
    });

    it('composes operations with Effect.gen', async () => {
      const result = await Effect.runPromise(dataPipelineEffect('user-1'));

      expect(result.postsCount).toBeGreaterThan(0);
    });
  });
});
