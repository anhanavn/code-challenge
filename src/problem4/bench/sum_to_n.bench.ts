import { bench, describe } from 'vitest';
import { sum_to_n_a, sum_to_n_b, sum_to_n_c } from '../src/sum_to_n';

for (const n of [100, 100_000]) {
  describe(`n = ${n}`, () => {
    bench('a: closed form', () => void sum_to_n_a(n));
    bench('b: loop', () => void sum_to_n_b(n));
    bench('c: divide & conquer', () => void sum_to_n_c(n));
  });
}
