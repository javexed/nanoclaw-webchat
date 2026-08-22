// Fail when a function PARAMETER shadows a reactive ref the same module imports.
//
// WHY. renderMembers(members) shadowed the imported `members` ref, so
// `members.value = members` set .value on the plain argument and left the ref
// the MembersList island reads untouched. Nothing threw. tsc was happy — the
// argument is `any`, and `.value` on `any` is legal. check-refs.sh was happy —
// the identifier IS defined, just not the one meant. The count came off the
// argument so it stayed correct, which made the symptom "the room says 1 member
// and lists nobody, including you" — reported from a phone after it shipped.
//
// The class is narrow and mechanical: a parameter named exactly like an
// imported binding, in a body that touches `<name>.value`. Reading it in review
// is hard precisely because the code looks right.
//
//   node ui/check-shadowed-refs.mjs [--selftest]   (from the repo root, as CI does)
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function scan(dir) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|vue)$/.test(e.name)) files.push(p);
    }
  })(dir);

  const hits = [];
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    const imported = new Set();
    for (const m of s.matchAll(/import \{([^}]+)\} from/g))
      for (const n of m[1].split(',')) imported.add(n.trim().split(/\s/)[0]);
    for (const m of s.matchAll(/function\s+(\w+)\s*\(([^)]*)\)/g)) {
      const params = m[2]
        .split(',')
        .map((p) => p.trim().split(/[?:=\s]/)[0])
        .filter(Boolean);
      for (const p of params) {
        if (!imported.has(p)) continue;
        const body = s.slice(m.index, m.index + 1500);
        if (new RegExp(`\\b${p}\\.value\\b`).test(body)) {
          hits.push(`${f}: function ${m[1]}(${p}) — the parameter shadows an imported ${p}, and the body touches ${p}.value`);
        }
      }
    }
  }
  return hits;
}

if (process.argv.includes('--selftest')) {
  const d = mkdtempSync(join(tmpdir(), 'shadow-selftest-'));
  writeFileSync(
    join(d, 'bad.ts'),
    "import { members } from './state.js';\nexport function renderMembers(members?: any) {\n  members.value = members;\n}\n",
  );
  const bad = scan(d);
  writeFileSync(
    join(d, 'bad.ts'),
    "import { members } from './state.js';\nexport function renderMembers(list?: any) {\n  members.value = list;\n}\n",
  );
  const good = scan(d);
  const ok = bad.length === 1 && good.length === 0;
  console.log(ok ? '  ok   detects the shadow, and clears once renamed' : `  FAIL bad=${bad.length} good=${good.length}`);
  process.exit(ok ? 0 : 1);
}

// Anchored to THIS file, not the cwd. The workflow runs it from the repo root
// as `node ui/check-shadowed-refs.mjs`, where a bare 'src' does not exist — the
// guard then dies with ENOENT instead of checking anything, which is a green
// self-test followed by a crash.
const hits = scan(join(import.meta.dirname, 'src'));
if (hits.length) {
  console.error('❌ a parameter shadows an imported ref (assignments land on the argument, not the ref):');
  for (const h of hits) console.error('   ' + h);
  process.exit(1);
}
console.log('✅ no parameter shadows an imported ref');
