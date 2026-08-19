import { defineConfig } from '@playwright/test';

/**
 * Live tests. These run against the REAL chain — every queue costs testnet
 * collateral and every fight is a fight that happened.
 *
 * The site under test is the local dev server by default, so a half-finished
 * change never reaches the public site. Point BASE_URL elsewhere to test a
 * deployment instead.
 *
 * No retries: a retried test would queue a second time and pay a second deposit,
 * and the first attempt's stake would sit in the queue behind it.
 */
export default defineConfig({
  testDir: './tests',
  // Two players in one fight have to be in the air at once, so the tests within a
  // file run together rather than one after another.
  fullyParallel: true,
  retries: 0,
  // A fight is paced by the chain: a turn every 600 blocks, and a 15-round fight
  // takes a quarter of an hour. The timeout has to cover the fight, not the click.
  timeout: 25 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Wallet discovery and the RPC both need real time on a public endpoint.
    actionTimeout: 60 * 1000,
    navigationTimeout: 90 * 1000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
