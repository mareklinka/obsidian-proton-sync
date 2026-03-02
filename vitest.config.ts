import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(__dirname, 'test/mocks/obsidian.ts')
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['isolated-sync/**/*.ts', 'services/**/*.ts'],
      exclude: ['isolated-sync/**/*.test.ts', 'proton-integration/**/*.test.ts', 'services/**/*.test.ts']
    }
  }
});
