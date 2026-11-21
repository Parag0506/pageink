import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { ciOptions } from '../core/vitest.ci';
import { commands } from '../core/vitest.commands';

// Pure logic runs in node. Anything that needs a DOM runs in real Chromium, WebKit and Firefox:
// *.browser.test.ts. CDP input exists only in Chromium; see pageink-core's capture/testkit.ts.
// The browser tests load the built dist/pageink.js, so the test script builds first.
// pageink-core's src/testkit.ts counts scheduled work so tests wait on it instead of sleeping.
export default defineConfig({
  test: {
    ...ciOptions('embed'),
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
          setupFiles: ['../core/src/testkit.ts'],
          // Every file runs on the same origin, so they share localStorage and IndexedDB, and
          // page.viewport() sizes the one page for all. One file at a time.
          fileParallelism: false,
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
