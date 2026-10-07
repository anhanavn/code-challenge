/**
 * Three ways to sum to n.
 *
 * Semantics (see README for the reasoning):
 *   sum_to_n(n)  = 1 + 2 + ... + n          for n > 0
 *   sum_to_n(0)  = 0
 *   sum_to_n(-n) = -sum_to_n(n)             for n < 0  (odd extension)
 *
 * The task guarantees the result stays below Number.MAX_SAFE_INTEGER, which
 * bounds |n| to MAX_N = 134_217_727. Inputs outside that contract are rejected
 * instead of silently returning an imprecise number.
 */

/** Largest |n| whose sum still fits in Number.MAX_SAFE_INTEGER. */
export const MAX_N = 134_217_727;

function assertValidInput(n: number): void {
  if (!Number.isInteger(n)) {
    throw new TypeError(`n must be an integer, received ${n}`);
  }
  if (Math.abs(n) > MAX_N) {
    throw new RangeError(`|n| must be <= ${MAX_N} so the result stays a safe integer, received ${n}`);
  }
}

/**
 * A) Closed form (Gauss): n(n + 1) / 2.
 *
 * Time O(1), space O(1). The one to use in production.
 *
 * Precision note: n(n + 1) may exceed MAX_SAFE_INTEGER (2^53 - 1) even when the
 * final sum does not. It is still exact: the product is always even and below
 * 2^54, and every even integer in [2^53, 2^54) is representable in float64.
 * The boundary test in the suite pins this down.
 */
export function sum_to_n_a(n: number): number {
  assertValidInput(n);
  const m = Math.abs(n);
  return Math.sign(n) * ((m * (m + 1)) / 2);
}

/**
 * B) Iterative loop.
 *
 * Time O(n), space O(1). The literal definition of the sum; easy to verify by
 * reading, and every partial sum is a safe integer so accumulation is exact.
 * ~100 ms at |n| = MAX_N in V8, i.e. fine for small inputs but needlessly
 * linear compared to (A).
 */
export function sum_to_n_b(n: number): number {
  assertValidInput(n);
  const m = Math.abs(n);
  let sum = 0;
  for (let i = 1; i <= m; i++) {
    sum += i;
  }
  return Math.sign(n) * sum || 0; // `|| 0` normalises -0 to 0
}

/**
 * C) Divide-and-conquer recursion: sum(lo..hi) = sum(lo..mid) + sum(mid+1..hi).
 *
 * Time O(n) (2n - 1 calls), space O(log n) call stack.
 *
 * The textbook recursion `n + sum(n - 1)` uses O(n) stack and throws
 * "Maximum call stack size exceeded" around n ≈ 10^4 in Node, because JS
 * engines do not implement tail-call optimisation. Splitting the range in half
 * keeps the depth at ~27 frames even for |n| = MAX_N, so it never overflows.
 * Still the slowest of the three because of per-call overhead.
 */
export function sum_to_n_c(n: number): number {
  assertValidInput(n);
  const m = Math.abs(n);
  if (m === 0) return 0;
  return Math.sign(n) * sumRange(1, m);
}

function sumRange(lo: number, hi: number): number {
  if (lo === hi) return lo;
  const mid = lo + Math.floor((hi - lo) / 2);
  return sumRange(lo, mid) + sumRange(mid + 1, hi);
}
