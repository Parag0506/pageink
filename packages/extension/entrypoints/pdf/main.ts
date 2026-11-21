import { pickApi } from '../../src/api';
import { startGuarded } from '../../src/pdf/guard';

// PDF.js is a separate chunk, so a browser too old for it still gets a message.
void startGuarded({
  doc: document,
  win: window,
  load: () => import('../../src/pdf/app'),
  start: (m) => m.startApp({ api: pickApi() }),
});
