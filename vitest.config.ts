import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/integration/global-setup.ts'],
          // Samostatné procesy: zdedia NODE_EXTRA_CA_CERTS nastavené v globalSetup.
          pool: 'forks',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false
        }
      }
    ]
  }
})
