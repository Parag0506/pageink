import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { ciOptions } from './vitest.ci';
import { commands } from './vitest.commands';

// Two projects. Pure logic runs in node. Anything that needs a DOM or layout
// runs in real Chromium, WebKit and Firefox: name the file *.browser.test.ts.
// CDP input exists only in Chromium; capture/testkit.ts sends the same events elsewhere.
// The test script runs one engine after the other, so the time budget tests are not
// measured while three browsers share the machine. In each engine the tests named
// "budget: ..." run on their own afterwards, one file at a time (vitest.ci.ts), so no other
// test file runs beside them either. src/testkit.ts counts the frames, idle
// callbacks and short timers the code schedules, so a test waits for the work to finish
// instead of sleeping. The test timeout is a backstop for slow shared runners: a test that
// works never comes near it.
export default defineConfig({
  test: {
    ...ciOptions('pageink-core'),
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.browser.test.ts'],
        },
      },
      {
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts'],
          setupFiles: ['src/testkit.ts'],
          testTimeout: 60_000,
          hookTimeout: 30_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'webkit' }, { browser: 'firefox' }],
            screenshotFailures: false,
            commands,
          },
        },
      },
    ],
  },
});
