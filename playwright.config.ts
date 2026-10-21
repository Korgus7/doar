import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
