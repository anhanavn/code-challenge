import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests run against real PostgreSQL (`npm run db:up`, or TEST_DATABASE_URL).
    // Global setup migrates a template database once; each test file gets its own clone.
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-file.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
