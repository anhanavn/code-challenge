import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_N, sum_to_n_a, sum_to_n_b, sum_to_n_c } from '../src/sum_to_n';

const implementations = [
  ['sum_to_n_a (closed form)', sum_to_n_a],
  ['sum_to_n_b (loop)', sum_to_n_b],
  ['sum_to_n_c (divide & conquer)', sum_to_n_c],
] as const;

/** Exact reference computed with BigInt, so it can't share float bugs with the code under test. */
function oracle(n: number): number {
  const m = BigInt(Math.abs(n));
  const sum = (m * (m + 1n)) / 2n;
  return n < 0 ? -Number(sum) : Number(sum);
}

describe.each(implementations)('%s', (_name, sum) => {
  it.each([
    [1, 1],
    [2, 3],
    [5, 15],
    [10, 55],
    [100, 5050],
  ])('sum(%i) === %i', (n, expected) => {
    expect(sum(n)).toBe(expected);
  });

  it('returns 0 (not -0) for 0', () => {
    expect(Object.is(sum(0), 0)).toBe(true);
  });

  it('mirrors positive results for negative n', () => {
    expect(sum(-1)).toBe(-1);
    expect(sum(-5)).toBe(-15);
  });

  it('matches the BigInt oracle for random integers', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), (n) => sum(n) === oracle(n)),
    );
  });

  it('rejects non-integers', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sum(bad)).toThrow(TypeError);
    }
  });

  it('rejects inputs whose result would exceed MAX_SAFE_INTEGER', () => {
    expect(() => sum(MAX_N + 1)).toThrow(RangeError);
    expect(() => sum(-(MAX_N + 1))).toThrow(RangeError);
  });
});

describe('upper boundary (|n| = MAX_N)', () => {
  const expected = oracle(MAX_N);

  it('MAX_N is the largest n whose sum is a safe integer', () => {
    expect(Number.isSafeInteger(expected)).toBe(true);
    expect(Number.isSafeInteger(oracle(MAX_N + 1))).toBe(false);
  });

  it('closed form stays exact even though n(n+1) > MAX_SAFE_INTEGER', () => {
    expect(MAX_N * (MAX_N + 1)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(sum_to_n_a(MAX_N)).toBe(expected);
    expect(sum_to_n_a(-MAX_N)).toBe(-expected);
  });

  it('closed form is exact for every n near the boundary', () => {
    for (let n = MAX_N - 10_000; n <= MAX_N; n++) {
      expect(sum_to_n_a(n)).toBe(oracle(n));
    }
  });

  it('loop is exact at the boundary', () => {
    expect(sum_to_n_b(MAX_N)).toBe(expected);
  });

  it('divide & conquer does not overflow the stack where naive recursion would', () => {
    expect(sum_to_n_c(MAX_N)).toBe(expected);
  });
});
