import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Vitest 4+ no longer excludes dist/ by default, and tsc emits the
    // compiled tests there.
    include: ['src/**/*.test.ts'],
  },
});
