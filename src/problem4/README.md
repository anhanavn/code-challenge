# Problem 4: Three ways to sum to n

Three implementations of `sum_to_n(n)` in TypeScript, with complexity notes, tests and a benchmark.

```bash
npm install
npm test           # 35 tests: examples, property-based checks, boundary cases
npm run typecheck  # tsc --strict
npm run bench      # optional: measures the complexity claims below
```

Requires Node 18+. The code is in [`src/sum_to_n.ts`](src/sum_to_n.ts).

## The three implementations

| | Approach | Time | Space | When to use |
|---|---|---|---|---|
| `sum_to_n_a` | Closed form `n(n+1)/2` | **O(1)** | O(1) | Always: this is the production answer |
| `sum_to_n_b` | `for` loop | O(n) | O(1) | When you want code that reads exactly like the definition |
| `sum_to_n_c` | Divide-and-conquer recursion | O(n) | O(log n) stack | A recursive version that cannot overflow the stack |

Benchmark on Node 22, Apple Silicon (`npm run bench`):

| n | a: closed form | b: loop | c: divide & conquer |
|---|---|---|---|
| 100 | 23.0 M ops/s | 9.6 M ops/s | 1.2 M ops/s |
| 100 000 | 23.1 M ops/s | 11.4 K ops/s | 1.1 K ops/s |

At n = 100 000, (a) runs about 2 000× faster than (b) and about 20 000× faster than (c). Its speed doesn't change with n.

### Why divide-and-conquer instead of plain recursion?

Plain recursion, `n + sum(n - 1)`, uses one stack frame per step. JS engines don't do tail-call optimisation, so Node throws `Maximum call stack size exceeded` at n = 10 000. Splitting the range in half, `sum(lo..mid) + sum(mid+1..hi)`, keeps the stack about 27 frames deep even at the largest allowed n. The total work is the same.

## Assumptions

The task says the input can be *any integer*, so three cases needed a decision:

1. **Negative n returns `-sum_to_n(|n|)`**, so `sum_to_n(-5) === -15`.
   "Summation to n" isn't defined for n < 1. Mirroring the positive result keeps the function odd (`f(-n) = -f(n)`), which is the least surprising choice. Another reasonable reading is the inclusive range `n + … + 1`, which gives `-14` for `-5`. Switching to that would change one line.
2. **`sum_to_n(0) === 0`**, the empty sum. All three versions return `+0`, never `-0`.
3. **Inputs outside the contract throw instead of returning a wrong number.**
   - A non-integer, `NaN` or `Infinity` throws `TypeError`.
   - `|n| > 134 217 727` throws `RangeError`. That is the largest n whose sum is still ≤ `Number.MAX_SAFE_INTEGER`, the guarantee the task gives. Past that point, float64 would quietly return an inexact result.

## Precision note on the closed form

At the largest allowed n, the intermediate product `n(n+1)` is above `MAX_SAFE_INTEGER` (2^53 − 1), so it looks like it could lose precision. It doesn't:

- If the sum is ≤ 2^53 − 1, the product `2 × sum` is below 2^54.
- Between 2^53 and 2^54, float64 can represent every **even** integer exactly.
- `n(n+1)` is always even.

So the formula is exact for every valid input, and there's no need to divide before multiplying. The test suite checks this against a BigInt reference for the 10 001 values of n just below the upper limit.

## Tests

[`test/sum_to_n.test.ts`](test/sum_to_n.test.ts) runs the same suite against all three versions:

- the example from the task (`sum_to_n(5) === 15`) and other known values
- `0`, negative inputs, and checks that the result is never `-0`
- a property-based test with [fast-check](https://github.com/dubzzz/fast-check) that compares each version to an exact **BigInt** reference on random integers in [-100 000, 100 000]
- upper-limit tests at `|n| = MAX_N`, including proof that (c) doesn't overflow the stack there
- rejection of invalid input
