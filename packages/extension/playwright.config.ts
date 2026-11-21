import { defineConfig } from '@playwright/test';

// Loads the real Chrome build (.output/chrome-mv3) into Chromium. Each test
// gets its own browser profile. INK_TARGET=edge runs the Edge build instead.

// Report the service worker's requests too, so the no-network check sees them (e2e/netlog.ts).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const ci = !!process.env.CI;

// Tests wait on what the page shows, with generous bounds: a slow machine makes them slower,
// not red. Each test starts its own Chromium, so a runner with 2 to 4 cores gets one worker.
// On CI a failed test runs once more, and scripts/test-summary.mjs lists every test that needed
// it in the job summary, so a flaky test is seen, not hidden.
export default defineConfig({
  testDir: 'e2e',
  // One folder for every browser profile of the run, removed when the run ends.
  globalSetup: './e2e/profiles.ts',
  timeout: ci ? 120_000 : 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: ci ? 1 : 2,
  retries: ci ? 1 : 0,
  reporter: ci
    ? [['list'], ['json', { outputFile: process.env.INK_E2E_JSON ?? 'test-results/report.json' }]]
    : [['list']],
  use: { trace: 'retain-on-failure' },
});
