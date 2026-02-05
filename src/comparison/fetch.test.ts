/**
 * Fetch Helpers Comparison Tests
 *
 * This file demonstrates type-safe HTTP operations with Result types.
 * Note: These tests use mock implementations that mirror the awaitly/fetch API.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err, type Result, type AsyncResult } from 'awaitly';

// ─────────────────────────────────────────────────────────────────────────────
// Mock fetch utilities (representing awaitly/fetch API)
// ─────────────────────────────────────────────────────────────────────────────

// Default error types from awaitly/fetch
type FetchErrorType =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR';

type FetchError = {
  type: FetchErrorType;
  status?: number;
  message?: string;
};

// Mock fetch implementation for testing
let mockFetchResponse: {
  status: number;
  body: unknown;
  shouldThrow?: boolean;
} = { status: 200, body: {} };

function setMockFetchResponse(response: typeof mockFetchResponse) {
  mockFetchResponse = response;
}

// Type-safe fetch helpers (mock implementations)
async function fetchJson<T, E = FetchError>(
  url: string,
  options?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    mapError?: (status: number, body: unknown) => E;
  }
): AsyncResult<T, E> {
  try {
    // Simulate network request
    if (mockFetchResponse.shouldThrow) {
      return err({ type: 'NETWORK_ERROR' } as unknown as E);
    }

    const { status, body } = mockFetchResponse;

    // Map status to error type
    if (status >= 400) {
      if (options?.mapError) {
        return err(options.mapError(status, body));
      }

      const errorType: FetchErrorType =
        status === 400
          ? 'BAD_REQUEST'
          : status === 401
            ? 'UNAUTHORIZED'
            : status === 403
              ? 'FORBIDDEN'
              : status === 404
                ? 'NOT_FOUND'
                : 'SERVER_ERROR';

      return err({ type: errorType, status } as unknown as E);
    }

    return ok(body as T);
  } catch {
    return err({ type: 'NETWORK_ERROR' } as unknown as E);
  }
}

async function fetchText(
  url: string,
  options?: { method?: string; body?: string }
): AsyncResult<string, FetchError> {
  const result = await fetchJson<string>(url, options);
  return result;
}

async function fetchBlob(
  url: string,
  options?: { method?: string }
): AsyncResult<Blob, FetchError> {
  const result = await fetchJson<Blob>(url, options);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types for tests
// ─────────────────────────────────────────────────────────────────────────────

type User = {
  id: string;
  name: string;
  email: string;
};

type CreateUserResponse = {
  id: string;
  createdAt: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Fetch: fetchJson basic usage', () => {
  it('returns typed success response', async () => {
    setMockFetchResponse({
      status: 200,
      body: { id: '1', name: 'Alice', email: 'alice@example.com' },
    });

    const result = await fetchJson<User>('/api/users/1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('1');
      expect(result.value.name).toBe('Alice');
      expect(result.value.email).toBe('alice@example.com');
    }
  });

  it('returns NOT_FOUND for 404', async () => {
    setMockFetchResponse({ status: 404, body: { message: 'User not found' } });

    const result = await fetchJson<User>('/api/users/999');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('NOT_FOUND');
      expect(result.error.status).toBe(404);
    }
  });

  it('returns BAD_REQUEST for 400', async () => {
    setMockFetchResponse({
      status: 400,
      body: { errors: ['Invalid email format'] },
    });

    const result = await fetchJson<CreateUserResponse>('/api/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'invalid' }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('BAD_REQUEST');
    }
  });

  it('returns UNAUTHORIZED for 401', async () => {
    setMockFetchResponse({ status: 401, body: { message: 'Token expired' } });

    const result = await fetchJson<User>('/api/users/me');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('UNAUTHORIZED');
    }
  });

  it('returns FORBIDDEN for 403', async () => {
    setMockFetchResponse({ status: 403, body: { message: 'Not allowed' } });

    const result = await fetchJson<User>('/api/admin/users');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('FORBIDDEN');
    }
  });

  it('returns SERVER_ERROR for 5xx', async () => {
    setMockFetchResponse({ status: 500, body: { message: 'Internal error' } });

    const result = await fetchJson<User>('/api/users/1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('SERVER_ERROR');
    }
  });

  it('returns NETWORK_ERROR for network failures', async () => {
    setMockFetchResponse({ status: 0, body: null, shouldThrow: true });

    const result = await fetchJson<User>('/api/users/1');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('NETWORK_ERROR');
    }
  });
});

describe('Fetch: custom error mapping', () => {
  type CheckoutError =
    | { type: 'INVENTORY_UNAVAILABLE'; productId: string }
    | { type: 'PAYMENT_DECLINED'; reason: string }
    | { type: 'API_ERROR'; status: number };

  it('maps 404 to custom error type', async () => {
    setMockFetchResponse({
      status: 404,
      body: { productId: 'prod_123' },
    });

    const result = await fetchJson<{ reserved: boolean }, CheckoutError>(
      '/api/inventory/check',
      {
        mapError: (status, body): CheckoutError => {
          if (status === 404) {
            return {
              type: 'INVENTORY_UNAVAILABLE',
              productId: (body as { productId?: string })?.productId ?? 'unknown',
            };
          }
          return { type: 'API_ERROR', status };
        },
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('INVENTORY_UNAVAILABLE');
      if (result.error.type === 'INVENTORY_UNAVAILABLE') {
        expect(result.error.productId).toBe('prod_123');
      }
    }
  });

  it('maps 402 to payment declined', async () => {
    setMockFetchResponse({
      status: 402,
      body: { message: 'Card declined' },
    });

    const result = await fetchJson<{ transactionId: string }, CheckoutError>(
      '/api/payments',
      {
        method: 'POST',
        mapError: (status, body): CheckoutError => {
          if (status === 402) {
            return {
              type: 'PAYMENT_DECLINED',
              reason: (body as { message?: string })?.message ?? 'Unknown',
            };
          }
          return { type: 'API_ERROR', status };
        },
      }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('PAYMENT_DECLINED');
      if (result.error.type === 'PAYMENT_DECLINED') {
        expect(result.error.reason).toBe('Card declined');
      }
    }
  });
});

describe('Fetch: POST with body', () => {
  it('sends JSON body and receives typed response', async () => {
    setMockFetchResponse({
      status: 201,
      body: { id: 'user_123', createdAt: '2024-01-01T00:00:00Z' },
    });

    const result = await fetchJson<CreateUserResponse>('/api/users', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('user_123');
      expect(result.value.createdAt).toBe('2024-01-01T00:00:00Z');
    }
  });
});

describe('Fetch: other content types', () => {
  it('fetchText returns string content', async () => {
    setMockFetchResponse({
      status: 200,
      body: '# README\n\nThis is the readme content.',
    });

    const result = await fetchText('/api/readme');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('README');
    }
  });

  it('fetchText handles errors', async () => {
    setMockFetchResponse({ status: 404, body: 'Not found' });

    const result = await fetchText('/api/missing');

    expect(result.ok).toBe(false);
  });
});

describe('Fetch: error handling patterns', () => {
  it('handles errors with switch statement', async () => {
    setMockFetchResponse({ status: 401, body: {} });

    const result = await fetchJson<User>('/api/users/me');

    let handled = '';

    if (!result.ok) {
      switch (result.error.type) {
        case 'UNAUTHORIZED':
          handled = 'redirect-to-login';
          break;
        case 'NOT_FOUND':
          handled = 'show-not-found';
          break;
        case 'NETWORK_ERROR':
          handled = 'show-offline-message';
          break;
        default:
          handled = 'show-generic-error';
      }
    }

    expect(handled).toBe('redirect-to-login');
  });

  it('provides fallback with orElse pattern', async () => {
    setMockFetchResponse({ status: 404, body: {} });

    const result = await fetchJson<User>('/api/users/999');

    const user: User = result.ok
      ? result.value
      : { id: '0', name: 'Guest', email: 'guest@example.com' };

    expect(user.name).toBe('Guest');
  });
});

describe('Fetch: integration with workflows', () => {
  it('composes multiple fetch calls in workflow pattern', async () => {
    // First call succeeds
    setMockFetchResponse({
      status: 200,
      body: { id: '1', name: 'Alice', email: 'alice@example.com' },
    });

    const userResult = await fetchJson<User>('/api/users/1');
    if (!userResult.ok) {
      throw new Error('Expected user to be fetched');
    }

    // Second call uses result from first
    setMockFetchResponse({
      status: 200,
      body: [{ id: 'post_1', title: 'Hello World', authorId: '1' }],
    });

    const postsResult = await fetchJson<Array<{ id: string; title: string }>>(
      `/api/users/${userResult.value.id}/posts`
    );

    expect(postsResult.ok).toBe(true);
    if (postsResult.ok) {
      expect(postsResult.value.length).toBe(1);
    }
  });

  it('short-circuits on first error', async () => {
    setMockFetchResponse({ status: 404, body: {} });

    const userResult = await fetchJson<User>('/api/users/999');

    // Should not proceed to posts fetch
    if (!userResult.ok) {
      expect(userResult.error.type).toBe('NOT_FOUND');
      return;
    }

    // This should not execute
    expect(true).toBe(false);
  });
});

describe('Fetch: type safety', () => {
  it('infers correct response type', async () => {
    setMockFetchResponse({
      status: 200,
      body: { id: '1', name: 'Alice', email: 'alice@example.com' },
    });

    const result = await fetchJson<User>('/api/users/1');

    if (result.ok) {
      // TypeScript knows these properties exist
      const id: string = result.value.id;
      const name: string = result.value.name;
      const email: string = result.value.email;

      expect(id).toBe('1');
      expect(name).toBe('Alice');
      expect(email).toBe('alice@example.com');
    }
  });

  it('handles union response types', async () => {
    type ApiResponse =
      | { status: 'success'; data: User }
      | { status: 'error'; message: string };

    setMockFetchResponse({
      status: 200,
      body: {
        status: 'success',
        data: { id: '1', name: 'Alice', email: 'alice@example.com' },
      },
    });

    const result = await fetchJson<ApiResponse>('/api/wrapped/users/1');

    if (result.ok) {
      if (result.value.status === 'success') {
        expect(result.value.data.name).toBe('Alice');
      }
    }
  });
});
