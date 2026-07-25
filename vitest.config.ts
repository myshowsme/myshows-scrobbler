import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    pool: 'forks',
    reporters: ['default'],
    testTimeout: 10_000,
  },
})
