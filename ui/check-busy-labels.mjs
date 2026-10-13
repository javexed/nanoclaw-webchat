// Fail when a wait is shown any way but the one pattern (DESIGN.md, "Long-running
// operations"): the pressed control's spinner, via buttonBusy/wizardBusy or
// <BusyLabel>.
//
// WHY. Every surface used to invent its own wait: a button relabelled
// "Saving…" with no spinner, a "Pending…" ternary in a template, an
// "Uploading…" toast. Each reads as a lesser affordance than the spinner
// elsewhere, and one, a bare status line under a sticky action bar, was half
// hidden. A 2026-10 sweep found 45 and brought them onto the pattern; this
// keeps new ones out.
//
// Three mechanical shapes, each a busy verb ("<Word>ing…") as a literal:
//   label   a control's label set to it:  btn.textContent = 'Saving…'
//   ternary a template label switched to it:  {{ busy ? 'Saving…' : 'Save' }}
//   toast   a toast announcing it:  showToast('Uploading…'), or an info toast
//           opening with one:  showToast('Preparing backup — …', { kind: 'info' })
// A deliberate exception carries `busy-ok` (with the reason) on the line, or on
// the line above.
//
//   node ui/check-busy-labels.mjs [--selftest]   (from the repo root, as CI does)
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const VERB = String.raw`[A-Z][a-z]+ing\b[^'"\x60]*…`;
const RULES = [
  {
    name: 'label',
    re: new RegExp(
      String.raw`\b\w*(?:btn|Btn|button|Button)\w*!?\.(?:textContent|innerText)\s*=\s*(?:[^;]*\?\s*)?(['"\x60])${VERB}\1`,
    ),
    fix: "buttonBusy(btn, 'Verb…') (core/busy.ts), restore in the finally",
  },
  {
    name: 'ternary',
    re: new RegExp(String.raw`\{\{[^}]*\?\s*(['"])${VERB}\1`),
    fix: '<BusyLabel :busy label busy-label> inside the button',
  },
  {
    name: 'toast',
    // An "…" verb, or an info toast that opens with one ("Preparing backup — this can take a while").
    re: new RegExp(
      String.raw`showToast\(\s*(?:(['"\x60])${VERB}\1|(['"\x60])[A-Z][a-z]+ing\b[^'"\x60]*\2\s*,\s*\{\s*kind:\s*'info')`,
    ),
    fix: 'buttonBusy on the control that started it; toast the outcome only',
  },
];

function scan(dir) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|vue)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
    }
  })(dir);

  const hits = [];
  for (const f of files) {
    if (f.endsWith(join('core', 'busy.ts'))) continue; // the primitive itself
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/busy-ok/.test(line) || /busy-ok/.test(lines[i - 1] ?? '')) return;
      for (const r of RULES) {
        if (r.re.test(line)) hits.push(`${f}:${i + 1}: ${r.name} — ${line.trim()}\n      → ${r.fix}`);
      }
    });
  }
  return hits;
}

if (process.argv.includes('--selftest')) {
  const d = mkdtempSync(join(tmpdir(), 'busy-selftest-'));
  writeFileSync(
    join(d, 'bad.ts'),
    [
      "  btn.textContent = 'Saving…';",
      "  saveBtn!.textContent = busy ? 'Installing…' : 'Install';",
      "  showToast('Uploading bundle…', { kind: 'info' });",
      "  showToast('Preparing backup — this can take a while', { kind: 'info' });",
    ].join('\n'),
  );
  writeFileSync(join(d, 'Bad.vue'), "<template><button>{{ busy ? 'Updating…' : 'Update' }}</button></template>\n");
  const bad = scan(d);
  writeFileSync(
    join(d, 'bad.ts'),
    [
      "  const restore = buttonBusy(btn, 'Saving…');",
      "  log.textContent = 'Starting…';",
      "  showToast('Saved', { kind: 'success' });",
      "  showToast('Room export started', { kind: 'info' });",
      "  // busy-ok: a countdown, not a wait",
      "  btn.textContent = 'Removing…';",
    ].join('\n'),
  );
  writeFileSync(
    join(d, 'Bad.vue'),
    '<template><button><BusyLabel :busy="busy" label="Update" busy-label="Updating…" /></button></template>\n',
  );
  const good = scan(d);
  const ok = bad.length === 5 && good.length === 0;
  console.log(
    ok
      ? '  ok   detects a bare label, a label ternary, a template ternary and two wait toasts; clears the pattern and busy-ok'
      : `  FAIL bad=${bad.length} (want 5) good=${good.length} (want 0)\n${[...bad, ...good].join('\n')}`,
  );
  process.exit(ok ? 0 : 1);
}

// Anchored to THIS file, not the cwd (CI runs it from the repo root).
const hits = scan(join(import.meta.dirname, 'src'));
if (hits.length) {
  console.error('❌ a wait shown outside the pattern (DESIGN.md, "Long-running operations"):');
  for (const h of hits) console.error('   ' + h);
  process.exit(1);
}
console.log('✅ every wait is on its control');
