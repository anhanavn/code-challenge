import { afterAll } from 'vitest';
import { releaseSharedDatabase } from '../helpers.js';

// Runs in every test file: drop that file's database when it finishes.
afterAll(releaseSharedDatabase);
