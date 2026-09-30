#!/usr/bin/env node
// check-setup-prompts.mjs — has upstream's setup grown a question our headless
// installers cannot answer?
//
//   node scripts/check-setup-prompts.mjs <composed-tree>          # check
//   node scripts/check-setup-prompts.mjs <composed-tree> --write  # refresh the baseline after review
//
// WHY THIS EXISTS. Both installers run upstream's `setup:auto` with stdin at
// /dev/null. A prompt they cannot answer does not fail: it cancels, and setup
// exits 0 part-way. A new upstream prompt (the hardened-image and Slack offers,
// for one) therefore breaks a fresh install silently, and the first to notice
// is a clean-box test, or a user. This check notices at the pin bump instead.
//
// TWO LISTS, in ci/setup-prompts.txt:
//   step <id> skip|run   every `skip.has('<id>')` step in setup/auto.ts. `skip`
//                        steps must be in the installers' NANOCLAW_SKIP;
//                        `run` steps are known to finish headless.
//   prompt <file> | <message>
//                        every interactive prompt under setup/, reviewed once
//                        for how a headless run gets past it (a skipped step,
//                        an .env value set beforehand, or unreachable headless).
// A step or prompt missing from the lists fails, naming it. Decide how the
// installers handle it, then run with --write and commit the list.
import fs from 'node:fs';
import path from 'node:path';

const [tree, flag] = process.argv.slice(2);
if (!tree || !fs.existsSync(path.join(tree, 'setup', 'auto.ts'))) {
  console.error('usage: check-setup-prompts.mjs <composed-tree> [--write]');
  process.exit(2);
}
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const baselinePath = process.env.SETUP_PROMPTS_BASELINE || path.join(repo, 'ci', 'setup-prompts.txt');
// install.sh runs setup:auto through webchat-deploy.sh's setup_auto_headless,
// so that file holds the one list both installers use.
const installers = ['app/deploy/webchat-deploy.sh'].map((p) =>
  path.join(process.env.SETUP_PROMPTS_INSTALLERS_ROOT || repo, p),
);
const sharedBy = path.join(process.env.SETUP_PROMPTS_INSTALLERS_ROOT || repo, 'app/deploy/install.sh');

// ── What upstream has ───────────────────────────────────────────────────────
const autoSrc = fs.readFileSync(path.join(tree, 'setup', 'auto.ts'), 'utf8');
const steps = [...new Set([...autoSrc.matchAll(/skip\.has\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))].sort();

const PROMPT_CALL = /\b(p\.(?:select|confirm|text|password|multiselect|groupMultiselect)|brightSelect|brightConfirm)\s*\(/g;
function messageAt(src, from) {
  const window = src.slice(from, from + 800);
  const m = /\bmessage:\s*/.exec(window);
  if (!m) return '(no message)';
  let i = m.index + m[0].length;
  const q = window[i];
  let out = '';
  if (q === "'" || q === '"' || q === '`') {
    for (i += 1; i < window.length && window[i] !== q; i++) {
      if (window[i] !== '\\') out += window[i];
      else out += /[nrt]/.test(window[++i]) ? ' ' : window[i];
    }
  } else {
    out = '<' + window.slice(i).split(/[,\n}]/)[0].trim() + '>';
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 120);
}
const prompts = new Map(); // key → "file:line"
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
      const src = fs.readFileSync(p, 'utf8');
      const rel = path.relative(tree, p);
      for (const m of src.matchAll(PROMPT_CALL)) {
        const key = `${rel} | ${messageAt(src, m.index)}`;
        if (!prompts.has(key)) prompts.set(key, `${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
}
walk(path.join(tree, 'setup'));

// ── What we have reviewed ───────────────────────────────────────────────────
const baseline = { steps: new Map(), prompts: new Set(), header: [] };
if (fs.existsSync(baselinePath)) {
  for (const line of fs.readFileSync(baselinePath, 'utf8').split('\n')) {
    let m;
    if ((m = /^step ([a-z0-9-]+) (skip|run)$/.exec(line))) baseline.steps.set(m[1], m[2]);
    else if ((m = /^prompt (.+)$/.exec(line))) baseline.prompts.add(m[1]);
    else if (!baseline.steps.size && !baseline.prompts.size) baseline.header.push(line);
  }
}

if (flag === '--write') {
  const unclassified = steps.filter((s) => !baseline.steps.has(s));
  if (unclassified.length) {
    console.error(`classify these steps in ${baselinePath} first (step <id> skip|run): ${unclassified.join(', ')}`);
    process.exit(1);
  }
  const out = [
    ...baseline.header.filter((l, i, a) => i < a.length - 1 || l !== ''),
    '',
    ...steps.map((s) => `step ${s} ${baseline.steps.get(s)}`),
    '',
    ...[...prompts.keys()].sort().map((k) => `prompt ${k}`),
    '',
  ];
  fs.writeFileSync(baselinePath, out.join('\n'));
  console.log(`wrote ${baselinePath}: ${steps.length} steps, ${prompts.size} prompts`);
  process.exit(0);
}

// ── Compare ─────────────────────────────────────────────────────────────────
const problems = [];
for (const s of steps) {
  if (!baseline.steps.has(s)) problems.push(`new setup step '${s}' (setup/auto.ts skip.has) — classify it skip or run`);
}
for (const file of installers) {
  const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lists = [...src.matchAll(/NANOCLAW_SKIP='([^']*)'/g)].map((m) => new Set(m[1].split(',')));
  if (lists.length === 0) {
    problems.push(`${path.relative(repo, file)}: no NANOCLAW_SKIP='…' found`);
    continue;
  }
  for (const [s, cls] of baseline.steps) {
    if (cls === 'skip' && steps.includes(s) && lists.some((l) => !l.has(s)))
      problems.push(`${path.relative(repo, file)}: NANOCLAW_SKIP lacks '${s}', which cannot run headless`);
  }
}
// …which only holds while install.sh has no setup:auto run of its own.
const sharedSrc = fs.existsSync(sharedBy) ? fs.readFileSync(sharedBy, 'utf8') : '';
if (/^[^#\n]*\brun setup:auto\b/m.test(sharedSrc))
  problems.push(`${path.relative(repo, sharedBy)}: runs setup:auto itself — use setup_auto_headless from webchat-deploy.sh`);
for (const [key, where] of prompts) {
  if (!baseline.prompts.has(key)) problems.push(`new prompt at ${where}: "${key.split(' | ').slice(1).join(' | ')}"`);
}
const gone = [...baseline.prompts].filter((k) => !prompts.has(k));

if (problems.length === 0) {
  console.log(`setup prompts OK: ${steps.length} steps, ${prompts.size} prompts, all reviewed`);
  if (gone.length) console.log(`  (${gone.length} reviewed prompt(s) no longer in upstream — refresh with --write)`);
  process.exit(0);
}
console.error("❌ setup prompts: upstream's setup changed in ways the headless installers have not been checked against:");
for (const p of problems) console.error(`   - ${p}`);
console.error('\n   For each: decide how a headless install gets past it — add the step to');
console.error('   NANOCLAW_SKIP in app/deploy/webchat-deploy.sh, or set its answer in .env before setup:auto runs —');
console.error(`   then refresh the reviewed list: node scripts/check-setup-prompts.mjs <composed-tree> --write`);
process.exit(1);
