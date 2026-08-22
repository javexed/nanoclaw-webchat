import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage();
await p.goto(process.argv[2], { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
// open the plant-vision room, then the members panel
const opened = await p.evaluate(() => {
  const el = [...document.querySelectorAll('#room-list li, .room-item')].find(e => (e.textContent||'').toLowerCase().includes('greensight') || (e.textContent||'').toLowerCase().includes('plant'));
  if (!el) return null; el.click(); return (el.textContent||'').trim().slice(0,30);
});
await p.waitForTimeout(2500);
const r = await p.evaluate(() => {
  document.querySelector('#members-toggle')?.click();
  const t = document.querySelector('#members-toggle');
  const list = document.querySelector('#members-list');
  return { count: t ? t.textContent : null, rows: list ? list.childElementCount : null,
           html: list ? list.textContent.trim().slice(0,120) : null };
});
console.log('  room opened:', opened);
console.log('  members-toggle count:', r.count, '| list rows:', r.rows);
console.log('  list text:', JSON.stringify(r.html));
await b.close();
