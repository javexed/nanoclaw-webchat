/**
 * Static integrity checks on the webchat bundle.
 *
 * `public/webchat/app.js` is a ~14k-line browser script with no build step and
 * no module system, so nothing catches a call to a function that does not exist
 * — it fails at runtime, in the browser, only on the code path that reaches it.
 *
 * That is not hypothetical: a range-based edit deleted `renderMyCredentials`
 * while leaving `void renderMyCredentials()` in `openSettings`. A missing
 * identifier throws a ReferenceError SYNCHRONOUSLY (the `void` on an async call
 * protects against a rejected promise, not an absent function), so it aborted
 * `openSettings` before the modal was revealed and the entire Settings page was
 * unopenable. `node --check` passes such a file happily.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

const APP_JS = path.join(process.cwd(), 'public', 'webchat', 'app.js');

/** Names declared at top level, in any of the forms the bundle uses. */
function declaredNames(src: string): Set<string> {
  const out = new Set<string>();
  for (const re of [
    /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm,
    /^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/gm,
    /^\s{2}(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm, // nested helpers
    /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/g,
    /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g,
  ]) {
    for (const m of src.matchAll(re)) out.add(m[1]);
  }
  return out;
}

/**
 * Bare calls to our own helpers: `foo(` not preceded by `.` (so DOM/builtin
 * methods are excluded) and matching the bundle's naming conventions, so this
 * stays a check on OUR code rather than a battle with the standard library.
 */
function calledHelpers(src: string): Map<string, number> {
  const out = new Map<string, number>();
  const OURS =
    /^(render|load|save|remove|create|open|close|wire|sync|show|append|toggle|refresh|probe|delete|update|my|deploy|tool|agent|room|user)[A-Z]/;
  // Prose inside strings ("repaired 3 agent(s)") and comments look exactly like
  // calls, so blank them out before scanning rather than trying to out-regex them.
  const lines = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, "''"));
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
      const name = m[2];
      if (!OURS.test(name)) continue; // our helpers are camelCase verb+Noun
      if (!out.has(name)) out.set(name, i + 1);
    }
  });
  return out;
}

describe('webchat app.js integrity', () => {
  const src = fs.readFileSync(APP_JS, 'utf-8');

  it('every helper it calls is actually declared', () => {
    const declared = declaredNames(src);
    const missing = [...calledHelpers(src)].filter(([name]) => !declared.has(name));
    expect(missing.map(([n, line]) => `${n}() called at app.js:${line} but never declared`)).toEqual([]);
  });

  it('openSettings only calls functions that exist — the Settings page must open', () => {
    const body = src.slice(src.indexOf('function openSettings()'));
    const end = body.indexOf('\n}\n');
    const declared = declaredNames(src);
    const calls = [...body.slice(0, end).matchAll(/(?:void\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)]
      .map((m) => m[1])
      .filter((n) => /^(render|open|close|load|sync)/.test(n));
    expect(calls.length).toBeGreaterThan(5); // sanity: we found the body
    expect(calls.filter((n) => !declared.has(n))).toEqual([]);
  });
});
