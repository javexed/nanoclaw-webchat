// Compare two boot traces as SEQUENCES. Reports the first divergence, not a set
// difference — "same events, different order" is the failure this exists for and
// a set comparison is blind to it by construction.
import { readFileSync } from 'fs';

const [aPath, bPath] = process.argv.slice(2);
const a = JSON.parse(readFileSync(aPath, 'utf8'));
const b = JSON.parse(readFileSync(bPath, 'utf8'));

const ta = a.trace, tb = b.trace;
console.log(`  baseline ${ta.length} events · candidate ${tb.length} events`);
if (a.errors?.length) console.log('  baseline errors:', a.errors.slice(0, 3));
if (b.errors?.length) console.log('  candidate errors:', b.errors.slice(0, 3));

const setA = new Set(ta), setB = new Set(tb);
const missing = ta.filter((e) => !setB.has(e));
const added = tb.filter((e) => !setA.has(e));
if (missing.length) console.log('  MISSING from candidate:', [...new Set(missing)].slice(0, 12));
if (added.length) console.log('  ADDED in candidate:', [...new Set(added)].slice(0, 12));

// order: first index where the two sequences disagree
let i = 0;
while (i < ta.length && i < tb.length && ta[i] === tb[i]) i++;
if (i === ta.length && i === tb.length) {
  console.log('  ✅ traces identical — same events, same order');
  process.exit(a.errors?.length || b.errors?.length ? 1 : 0);
}
console.log(`  ✗ diverges at event ${i}:`);
console.log(`      baseline : ${ta.slice(i, i + 4).join(' | ') || '(end)'}`);
console.log(`      candidate: ${tb.slice(i, i + 4).join(' | ') || '(end)'}`);
process.exit(1);
