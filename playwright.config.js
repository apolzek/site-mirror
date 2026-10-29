import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.js',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1, // fixed ports, one persistent browser with the extension
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
