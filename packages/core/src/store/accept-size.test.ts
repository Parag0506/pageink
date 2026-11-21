// acceptRecord is used from the view chunk, through the folder index. It must not pull in
// the folder sync, the archive code or the zip library.
import { fileURLToPath } from 'node:url';
import { build, type Rolldown } from 'vite';
import { expect, test } from 'vitest';

test('importing acceptRecord from the store index brings no sync, archive or zip code', async () => {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      rollupOptions: {
        input: fileURLToPath(new URL('./testkit-accept.ts', import.meta.url)),
        output: { format: 'es' },
        preserveEntrySignatures: 'strict',
      },
    },
  });
  const list = (Array.isArray(out) ? out : [out]) as Rolldown.RolldownOutput[];
  const chunks = list.flatMap((o) => o.output).filter((c): c is Rolldown.OutputChunk => c.type === 'chunk');
  const mods = chunks.flatMap((c) => c.moduleIds);
  expect(mods.filter((m) => /store[\\/](sync|markdown|ops)\.ts|fflate/.test(m))).toEqual([]);
  expect(mods.some((m) => /store[\\/]validate\.ts/.test(m))).toBe(true);
}, 60_000);
