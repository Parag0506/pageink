// A Vitest reporter for scripts/soak.mjs. It writes one JSON file with every test of the run:
// project (which names the browser), file, full name, state and error messages. Errors of a
// file that never ran its tests, and errors no test owns, are written too.
// The file to write is named by INK_SOAK_REPORT.
import { writeFileSync } from 'node:fs';

const text = (e) => String(e?.stack && !e.message ? e.stack : (e?.message ?? e)).slice(0, 4000);

export default class SoakReporter {
  onTestRunEnd(modules, unhandled) {
    const tests = [];
    const errors = [];
    const walk = (mod, node) => {
      for (const child of node.children) {
        if (child.type === 'suite') {
          walk(mod, child);
          for (const e of child.errors?.() ?? []) errors.push({ ...where(mod), message: text(e) });
          continue;
        }
        const r = child.result();
        tests.push({
          ...where(mod),
          name: child.fullName,
          state: r.state,
          ms: Math.round(child.diagnostic()?.duration ?? 0),
          retries: child.diagnostic()?.retryCount ?? 0,
          messages: (r.errors ?? []).map(text),
        });
      }
    };
    const where = (mod) => ({ project: mod.project.name, file: mod.relativeModuleId });
    for (const mod of modules) {
      walk(mod, mod);
      for (const e of mod.errors()) errors.push({ ...where(mod), message: text(e) });
    }
    for (const e of unhandled) errors.push({ project: '', file: '', message: text(e) });
    const out = process.env.INK_SOAK_REPORT;
    if (out) writeFileSync(out, JSON.stringify({ tests, errors }));
  }
}
