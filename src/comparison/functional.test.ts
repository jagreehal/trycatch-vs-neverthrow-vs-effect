/**
 * Functional Utilities Comparison Tests
 *
 * This file demonstrates functional composition patterns for Result types.
 * Note: These tests use implementations that mirror the awaitly/functional API.
 */
import { describe, it, expect } from 'vitest';
import { ok, err, type Result, type AsyncResult } from 'awaitly';

// ─────────────────────────────────────────────────────────────────────────────
// Mock functional utilities (representing awaitly/functional API)
// ─────────────────────────────────────────────────────────────────────────────

// pipe: Apply functions left-to-right to a value
function pipe<A>(a: A): A;
function pipe<A, B>(a: A, fn1: (a: A) => B): B;
function pipe<A, B, C>(a: A, fn1: (a: A) => B, fn2: (b: B) => C): C;
function pipe<A, B, C, D>(
  a: A,
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D
): D;
function pipe(a: unknown, ...fns: Array<(x: unknown) => unknown>): unknown {
  return fns.reduce((acc, fn) => fn(acc), a);
}

// flow: Compose functions left-to-right (returns a function)
function flow<A, B>(fn1: (a: A) => B): (a: A) => B;
function flow<A, B, C>(fn1: (a: A) => B, fn2: (b: B) => C): (a: A) => C;
function flow<A, B, C, D>(
  fn1: (a: A) => B,
  fn2: (b: B) => C,
  fn3: (c: C) => D
): (a: A) => D;
function flow(...fns: Array<(x: unknown) => unknown>): (a: unknown) => unknown {
  return (a) => fns.reduce((acc, fn) => fn(acc), a);
}

// R namespace: Curried pipeable functions for Results
const R = {
  map:
    <A, B>(fn: (a: A) => B) =>
    <E>(result: Result<A, E>): Result<B, E> =>
      result.ok ? ok(fn(result.value)) : result,

  mapError:
    <E1, E2>(fn: (e: E1) => E2) =>
    <A>(result: Result<A, E1>): Result<A, E2> =>
      result.ok ? result : err(fn(result.error)),

  andThen:
    <A, B, E2>(fn: (a: A) => Result<B, E2>) =>
    <E1>(result: Result<A, E1>): Result<B, E1 | E2> =>
      result.ok ? fn(result.value) : result,

  orElse:
    <A, E1, E2>(fn: (e: E1) => Result<A, E2>) =>
    (result: Result<A, E1>): Result<A, E2> =>
      result.ok ? result : fn(result.error),

  unwrapOr:
    <A>(defaultValue: A) =>
    <E>(result: Result<A, E>): A =>
      result.ok ? result.value : defaultValue,

  tap:
    <A>(fn: (a: A) => void) =>
    <E>(result: Result<A, E>): Result<A, E> => {
      if (result.ok) fn(result.value);
      return result;
    },

  tapError:
    <E>(fn: (e: E) => void) =>
    <A>(result: Result<A, E>): Result<A, E> => {
      if (!result.ok) fn(result.error);
      return result;
    },

  filter:
    <A, E2>(predicate: (a: A) => boolean, error: E2) =>
    <E1>(result: Result<A, E1>): Result<A, E1 | E2> =>
      result.ok ? (predicate(result.value) ? result : err(error)) : result,
};

// Collection utilities
function all<T extends readonly Result<unknown, unknown>[]>(
  results: T
): Result<{ [K in keyof T]: T[K] extends Result<infer V, unknown> ? V : never },
          T[number] extends Result<unknown, infer E> ? E : never> {
  const values: unknown[] = [];
  for (const result of results) {
    if (!result.ok) return result as any;
    values.push(result.value);
  }
  return ok(values) as any;
}

async function allAsync<T, E>(
  results: AsyncResult<T, E>[]
): AsyncResult<T[], E> {
  const values: T[] = [];
  for (const resultPromise of results) {
    const result = await resultPromise;
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

function allSettled<T, E>(
  results: Result<T, E>[]
): Result<T[], { index: number; error: E }[]> {
  const values: T[] = [];
  const errors: { index: number; error: E }[] = [];

  results.forEach((result, index) => {
    if (result.ok) {
      values.push(result.value);
    } else {
      errors.push({ index, error: result.error });
    }
  });

  return errors.length > 0 ? err(errors) : ok(values);
}

async function any<T, E>(
  results: AsyncResult<T, E>[]
): AsyncResult<T, E[]> {
  const errors: E[] = [];
  for (const resultPromise of results) {
    const result = await resultPromise;
    if (result.ok) return result;
    errors.push(result.error);
  }
  return err(errors);
}

async function race<T, E>(
  results: AsyncResult<T, E>[]
): AsyncResult<T, E> {
  return Promise.race(results);
}

async function traverse<T, U, E>(
  items: T[],
  fn: (item: T) => AsyncResult<U, E>
): AsyncResult<U[], E> {
  return allAsync(items.map(fn));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Functional: pipe', () => {
  it('applies single function', () => {
    const result = pipe(5, (x) => x * 2);
    expect(result).toBe(10);
  });

  it('applies multiple functions left-to-right', () => {
    const result = pipe(
      5,
      (x) => x * 2, // 10
      (x) => x + 3, // 13
      (x) => x.toString() // "13"
    );
    expect(result).toBe('13');
  });

  it('works with Result types', () => {
    const result = pipe(
      ok(5) as Result<number, string>,
      R.map((x) => x * 2),
      R.map((x) => x + 3)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(13);
    }
  });
});

describe('Functional: flow', () => {
  it('creates reusable pipeline', () => {
    const doubleAndAdd = flow(
      (x: number) => x * 2,
      (x) => x + 10
    );

    expect(doubleAndAdd(5)).toBe(20);
    expect(doubleAndAdd(10)).toBe(30);
  });

  it('works with Result-returning functions', () => {
    const validate = (x: number): Result<number, string> =>
      x > 0 ? ok(x) : err('Must be positive');

    const double = (x: number): Result<number, string> => ok(x * 2);

    const processNumber = flow(
      validate,
      R.andThen(double)
    );

    const success = processNumber(5);
    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(success.value).toBe(10);
    }

    const failure = processNumber(-5);
    expect(failure.ok).toBe(false);
  });
});

describe('Functional: R.map', () => {
  it('transforms success value', () => {
    const result = pipe(
      ok(5) as Result<number, string>,
      R.map((x) => x * 2)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(10);
    }
  });

  it('passes through error', () => {
    const result = pipe(
      err('ERROR') as Result<number, string>,
      R.map((x: number) => x * 2)
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ERROR');
    }
  });
});

describe('Functional: R.mapError', () => {
  it('transforms error value', () => {
    const result = pipe(
      err('ERROR') as Result<number, string>,
      R.mapError((e) => ({ code: e, message: 'Something went wrong' }))
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: 'ERROR',
        message: 'Something went wrong',
      });
    }
  });

  it('passes through success', () => {
    const result = pipe(
      ok(5) as Result<number, string>,
      R.mapError((e: string) => ({ code: e }))
    );

    expect(result.ok).toBe(true);
  });
});

describe('Functional: R.andThen', () => {
  it('chains successful operations', () => {
    const fetchUser = (id: string): Result<{ id: string; name: string }, 'NOT_FOUND'> =>
      id === '1' ? ok({ id, name: 'Alice' }) : err('NOT_FOUND');

    const fetchPosts = (userId: string): Result<string[], 'FETCH_ERROR'> =>
      ok([`Post by ${userId}`]);

    const result = pipe(
      fetchUser('1'),
      R.andThen((user) => fetchPosts(user.id))
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['Post by 1']);
    }
  });

  it('short-circuits on error', () => {
    const fetchUser = (id: string): Result<{ id: string }, 'NOT_FOUND'> =>
      id === '1' ? ok({ id }) : err('NOT_FOUND');

    const fetchPosts = (userId: string): Result<string[], 'FETCH_ERROR'> =>
      ok([`Post by ${userId}`]);

    const result = pipe(
      fetchUser('999'),
      R.andThen((user) => fetchPosts(user.id))
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('NOT_FOUND');
    }
  });
});

describe('Functional: R.orElse', () => {
  it('recovers from error', () => {
    const result = pipe(
      err('NOT_FOUND') as Result<string, string>,
      R.orElse(() => ok('default'))
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('default');
    }
  });

  it('passes through success', () => {
    const result = pipe(
      ok('value') as Result<string, string>,
      R.orElse(() => ok('default'))
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('value');
    }
  });
});

describe('Functional: R.unwrapOr', () => {
  it('returns value on success', () => {
    const value = pipe(ok(5) as Result<number, string>, R.unwrapOr(0));
    expect(value).toBe(5);
  });

  it('returns default on error', () => {
    const value = pipe(err('ERROR') as Result<number, string>, R.unwrapOr(0));
    expect(value).toBe(0);
  });
});

describe('Functional: R.tap', () => {
  it('executes side effect without changing value', () => {
    const sideEffects: number[] = [];

    const result = pipe(
      ok(5) as Result<number, string>,
      R.tap((x) => sideEffects.push(x)),
      R.map((x) => x * 2)
    );

    expect(sideEffects).toEqual([5]);
    expect(result.ok && result.value).toBe(10);
  });
});

describe('Functional: R.filter', () => {
  it('passes value matching predicate', () => {
    const result = pipe(
      ok(10) as Result<number, string>,
      R.filter((x) => x > 5, 'TOO_SMALL')
    );

    expect(result.ok).toBe(true);
  });

  it('returns error when predicate fails', () => {
    const result = pipe(
      ok(3) as Result<number, string>,
      R.filter((x) => x > 5, 'TOO_SMALL')
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('TOO_SMALL');
    }
  });
});

describe('Functional: all', () => {
  it('combines successful results', () => {
    const result = all([ok(1), ok(2), ok(3)] as const);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it('returns first error', () => {
    const result = all([ok(1), err('ERROR'), ok(3)] as const);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ERROR');
    }
  });
});

describe('Functional: allAsync', () => {
  it('combines async successful results', async () => {
    const results = [
      Promise.resolve(ok(1)),
      Promise.resolve(ok(2)),
      Promise.resolve(ok(3)),
    ];

    const result = await allAsync(results);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it('returns first async error', async () => {
    const results = [
      Promise.resolve(ok(1)),
      Promise.resolve(err('ERROR') as Result<number, string>),
      Promise.resolve(ok(3)),
    ];

    const result = await allAsync(results);

    expect(result.ok).toBe(false);
  });
});

describe('Functional: allSettled', () => {
  it('collects all errors', () => {
    const result = allSettled([
      ok(1),
      err('ERROR1'),
      ok(3),
      err('ERROR2'),
    ] as Result<number, string>[]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBe(2);
      expect(result.error[0]).toEqual({ index: 1, error: 'ERROR1' });
      expect(result.error[1]).toEqual({ index: 3, error: 'ERROR2' });
    }
  });

  it('returns all values on success', () => {
    const result = allSettled([ok(1), ok(2), ok(3)] as Result<number, string>[]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });
});

describe('Functional: any', () => {
  it('returns first success', async () => {
    const results = [
      Promise.resolve(err('ERROR1') as Result<number, string>),
      Promise.resolve(ok(2)),
      Promise.resolve(ok(3)),
    ];

    const result = await any(results);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(2);
    }
  });

  it('collects all errors if none succeed', async () => {
    const results = [
      Promise.resolve(err('ERROR1') as Result<number, string>),
      Promise.resolve(err('ERROR2') as Result<number, string>),
    ];

    const result = await any(results);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(['ERROR1', 'ERROR2']);
    }
  });
});

describe('Functional: traverse', () => {
  it('maps and combines results', async () => {
    const ids = ['1', '2', '3'];
    const fetchUser = (id: string): AsyncResult<{ id: string }, 'NOT_FOUND'> =>
      Promise.resolve(ok({ id }));

    const result = await traverse(ids, fetchUser);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
      expect(result.value.map((u) => u.id)).toEqual(['1', '2', '3']);
    }
  });

  it('returns first error', async () => {
    const ids = ['1', 'bad', '3'];
    const fetchUser = (id: string): AsyncResult<{ id: string }, 'NOT_FOUND'> =>
      id === 'bad'
        ? Promise.resolve(err('NOT_FOUND'))
        : Promise.resolve(ok({ id }));

    const result = await traverse(ids, fetchUser);

    expect(result.ok).toBe(false);
  });
});

describe('Functional: complex pipeline', () => {
  it('composes validation pipeline', () => {
    type User = { email: string; password: string; age: number };
    type ValidationError = 'INVALID_EMAIL' | 'WEAK_PASSWORD' | 'TOO_YOUNG';

    const validateEmail = (user: User): Result<User, ValidationError> =>
      user.email.includes('@') ? ok(user) : err('INVALID_EMAIL');

    const validatePassword = (user: User): Result<User, ValidationError> =>
      user.password.length >= 8 ? ok(user) : err('WEAK_PASSWORD');

    const validateAge = (user: User): Result<User, ValidationError> =>
      user.age >= 18 ? ok(user) : err('TOO_YOUNG');

    const validateUser = flow(
      validateEmail,
      R.andThen(validatePassword),
      R.andThen(validateAge)
    );

    const validUser = validateUser({
      email: 'alice@example.com',
      password: 'securepass123',
      age: 25,
    });

    expect(validUser.ok).toBe(true);

    const invalidEmail = validateUser({
      email: 'not-an-email',
      password: 'securepass123',
      age: 25,
    });

    expect(invalidEmail.ok).toBe(false);
    if (!invalidEmail.ok) {
      expect(invalidEmail.error).toBe('INVALID_EMAIL');
    }
  });
});
