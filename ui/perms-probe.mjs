import { chromium } from 'playwright';
const URL = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage();
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200)); });
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).slice(0, 300)));
await p.goto(URL, { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
// open the overflow menu, then the users/permissions entry
const openedMenu = await p.evaluate(() => { document.querySelector('#overflow-btn')?.click(); return true; });
await p.waitForTimeout(400);
const permsEntry = await p.evaluate(() => {
  const el = document.querySelector('#overflow-permissions');
  if (!el) return null;
  el.click();
  return el.id || el.getAttribute('data-view');
});
await p.waitForTimeout(2000);
const state = await p.evaluate(() => {
  const sec = document.querySelector('#permissions');
  const list = document.querySelector('#perms-user-list');
  return {
    sectionExists: !!sec,
    sectionHidden: sec ? sec.hidden : null,
    listExists: !!list,
    listChildren: list ? list.childElementCount : null,
    listHTML: list ? list.innerHTML.slice(0, 200) : null,
  };
});
console.log('  menu opened:', openedMenu, '| perms entry clicked:', permsEntry);
console.log('  permissions section hidden:', state.sectionHidden, '| #perms-user-list children:', state.listChildren);
console.log('  list html:', JSON.stringify(state.listHTML));
if (errs.length) { console.log('  --- errors:'); errs.slice(0, 6).forEach((e) => console.log('   ', e)); }
else console.log('  no console/page errors');
await b.close();
