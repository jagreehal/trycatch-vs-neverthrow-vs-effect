/**
 * Streaming Comparison Tests
 *
 * This file demonstrates streaming patterns with Result types.
 * Note: These tests use mock implementations to show the API patterns
 * that awaitly/streaming provides.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err, type Result, type AsyncResult } from 'awaitly';
import { createWorkflow } from 'awaitly/workflow';

// ─────────────────────────────────────────────────────────────────────────────
// Mock streaming utilities (representing awaitly/streaming API)
// ─────────────────────────────────────────────────────────────────────────────

// Simulated map transformer
function mapStream<T, U, E>(
  items: T[],
  fn: (item: T) => Result<U, E>
): Result<U, E>[] {
  return items.map(fn);
}

// Simulated filter transformer
function filterStream<T, E>(
  items: Result<T, E>[],
  predicate: (item: T) => boolean
): Result<T, E>[] {
  return items.filter((r) => r.ok && predicate(r.value));
}

// Simulated chunk transformer
function chunkStream<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// Simulated collect
function collectStream<T, E>(items: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const item of items) {
    if (!item.ok) return item;
    values.push(item.value);
  }
  return ok(values);
}

// Simulated reduce
function reduceStream<T, U, E>(
  items: Result<T, E>[],
  fn: (acc: U, item: T) => U,
  initial: U
): Result<U, E> {
  let acc = initial;
  for (const item of items) {
    if (!item.ok) return item;
    acc = fn(acc, item.value);
  }
  return ok(acc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LogLine = {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
};

type ParseError = 'PARSE_ERROR';
type ValidationError = 'INVALID_LOG';

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Streaming: map transformer', () => {
  it('transforms items with Result wrapping', () => {
    const lines = ['INFO|Hello', 'WARN|Warning', 'ERROR|Critical'];

    const parseLine = (line: string): Result<LogLine, ParseError> => {
      const parts = line.split('|');
      if (parts.length !== 2) return err('PARSE_ERROR');
      return ok({
        timestamp: new Date().toISOString(),
        level: parts[0] as LogLine['level'],
        message: parts[1],
      });
    };

    const results = mapStream(lines, parseLine);

    expect(results.length).toBe(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('propagates errors through map', () => {
    const lines = ['INFO|Hello', 'INVALID', 'ERROR|Critical'];

    const parseLine = (line: string): Result<LogLine, ParseError> => {
      const parts = line.split('|');
      if (parts.length !== 2) return err('PARSE_ERROR');
      return ok({
        timestamp: new Date().toISOString(),
        level: parts[0] as LogLine['level'],
        message: parts[1],
      });
    };

    const results = mapStream(lines, parseLine);

    expect(results.length).toBe(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
  });
});

describe('Streaming: filter transformer', () => {
  it('filters based on predicate', () => {
    const items: Result<LogLine, ParseError>[] = [
      ok({ timestamp: '2024-01-01', level: 'INFO', message: 'Hello' }),
      ok({ timestamp: '2024-01-01', level: 'ERROR', message: 'Critical' }),
      ok({ timestamp: '2024-01-01', level: 'WARN', message: 'Warning' }),
    ];

    const errorLogs = filterStream(items, (log) => log.level === 'ERROR');

    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0].ok && errorLogs[0].value.level).toBe('ERROR');
  });

  it('handles mixed success and error results', () => {
    const items: Result<LogLine, ParseError>[] = [
      ok({ timestamp: '2024-01-01', level: 'INFO', message: 'Hello' }),
      err('PARSE_ERROR'),
      ok({ timestamp: '2024-01-01', level: 'ERROR', message: 'Critical' }),
    ];

    // Filter only keeps successful results that match predicate
    const errorLogs = filterStream(items, (log) => log.level === 'ERROR');

    expect(errorLogs.length).toBe(1);
  });
});

describe('Streaming: chunk transformer', () => {
  it('batches items into chunks', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    const chunks = chunkStream(items, 3);

    expect(chunks.length).toBe(4);
    expect(chunks[0]).toEqual([1, 2, 3]);
    expect(chunks[1]).toEqual([4, 5, 6]);
    expect(chunks[2]).toEqual([7, 8, 9]);
    expect(chunks[3]).toEqual([10]);
  });

  it('handles exact divisible chunks', () => {
    const items = [1, 2, 3, 4, 5, 6];

    const chunks = chunkStream(items, 2);

    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length === 2)).toBe(true);
  });
});

describe('Streaming: collect', () => {
  it('collects all successful results', () => {
    const items: Result<number, string>[] = [ok(1), ok(2), ok(3)];

    const result = collectStream(items);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
    }
  });

  it('returns first error encountered', () => {
    const items: Result<number, string>[] = [ok(1), err('ERROR'), ok(3)];

    const result = collectStream(items);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ERROR');
    }
  });
});

describe('Streaming: reduce', () => {
  it('reduces to single value', () => {
    const items: Result<number, string>[] = [ok(1), ok(2), ok(3), ok(4)];

    const result = reduceStream(items, (acc, x) => acc + x, 0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(10);
    }
  });

  it('stops on first error', () => {
    const items: Result<number, string>[] = [ok(1), ok(2), err('ERROR'), ok(4)];

    const result = reduceStream(items, (acc, x) => acc + x, 0);

    expect(result.ok).toBe(false);
  });
});

describe('Streaming: integration with workflows', () => {
  it('processes stream in workflow with caching', async () => {
    const processLine = (line: string): AsyncResult<string, 'PROCESS_ERROR'> =>
      Promise.resolve(ok(line.toUpperCase()));

    const saveBatch = (
      batch: string[]
    ): AsyncResult<number, 'SAVE_ERROR'> =>
      Promise.resolve(ok(batch.length));

    const workflow = createWorkflow({ processLine, saveBatch });

    const lines = ['hello', 'world', 'test'];
    let totalSaved = 0;

    const result = await workflow(async (step, deps) => {
      // Process lines
      const processed: string[] = [];
      for (const line of lines) {
        const lineResult = await step('processLine', () => deps.processLine(line), {
          key: `process:${line}`,
        });
        processed.push(lineResult);
      }

      // Batch save
      const chunks = chunkStream(processed, 2);
      for (const chunk of chunks) {
        const saved = await step('saveBatch', () => deps.saveBatch(chunk), {
          key: `save:${chunks.indexOf(chunk)}`,
        });
        totalSaved += saved;
      }

      return { processed: processed.length, saved: totalSaved };
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.processed).toBe(3);
      expect(result.value.saved).toBe(3);
    }
  });

  it('handles errors in stream processing', async () => {
    const processLine = (line: string): AsyncResult<string, 'PROCESS_ERROR'> =>
      line === 'bad'
        ? Promise.resolve(err('PROCESS_ERROR'))
        : Promise.resolve(ok(line.toUpperCase()));

    const workflow = createWorkflow({ processLine });

    const lines = ['hello', 'bad', 'world'];

    const result = await workflow(async (step, deps) => {
      const processed: string[] = [];
      for (const line of lines) {
        const lineResult = await step('processLine', () => deps.processLine(line));
        processed.push(lineResult);
      }
      return processed;
    });

    // Should fail on 'bad' line
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('PROCESS_ERROR');
    }
  });
});

describe('Streaming: backpressure simulation', () => {
  it('processes with simulated backpressure', async () => {
    const processedItems: number[] = [];
    let backpressureHits = 0;

    const processItem = async (item: number): Promise<void> => {
      // Simulate slow processing
      await new Promise((r) => setTimeout(r, 10));
      processedItems.push(item);
    };

    // Simulate backpressure with high water mark
    const highWaterMark = 3;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let pending = 0;

    for (const item of items) {
      pending++;

      if (pending >= highWaterMark) {
        backpressureHits++;
        // Wait for processing to catch up
        await new Promise((r) => setTimeout(r, 50));
        pending = 0;
      }

      await processItem(item);
    }

    expect(processedItems.length).toBe(10);
    expect(backpressureHits).toBeGreaterThan(0);
  });
});
