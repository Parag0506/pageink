import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { ciOptions } from '../core/vitest.ci';
import { defines } from './build/targets.ts';

// Pure logic runs in node. DOM and IndexedDB tests are *.browser.test.ts and
// run in real Chromium, WebKit and Firefox. The bundle tests read the builds in .output.
const shared = { define: defines('chrome') };

export default defineConfig({
  test: {
    ...ciOptions('extension'),
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          environment: 'node',
          // The build checks parse every file of four builds, PDF.js included. The first file
          // parsed pays for cold reads and an unwarmed parser, and the three browsers start at the
          // same time, so on the first run after a build one test took over 4 s of the default 5 s.
          testTimeout: 60_000,
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['src/**/*.browser.test.ts'],
        },
      },
      {
        ...shared,
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts'],
          // pageink-core's testkit counts scheduled work, so a test waits for it instead of sleeping.
          setupFiles: ['../core/src/testkit.ts'],
          testTimeout: 60_000,
          hookTimeout: 30_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'webkit' }, { browser: 'firefox' }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
