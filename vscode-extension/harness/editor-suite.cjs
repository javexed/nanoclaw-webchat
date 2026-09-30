// Runs INSIDE VS Code's extension host (see editor-review.mjs). Plain asserts;
// each scenario prints PASS/FAIL and the run fails on any failure.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { planPropose } = require('../out/inline-review.js');

const BASE = ['import a', 'import b', '', 'function f() {', '  return 1;', '}', '', 'function g() {', '  return 2;', '}', ''].join('\n');
const PROPOSAL = ['import a', 'import b', 'import c', '', 'function f() {', '  return 42;', '}', '', 'function g() {', '  return 2;', '}', ''].join('\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

exports.run = async function run() {
  const ws = process.env.NCL_EDITOR_WS;
  const pkg = require('../package.json');
  const extension = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
  const { review, conflicts } = await extension.activate();
  const failures = [];
  const scenario = async (name, fn) => {
    const file = path.join(ws, `${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.ts`);
    try {
      await fn(file);
      console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    } catch (err) {
      failures.push(name);
      console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n        ')}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  };
  const startReview = async (file, makePlan) => {
    let result = null;
    const uri = vscode.Uri.file(file);
    await review.start(uri, makePlan, (r) => (result = r));
    const doc = await vscode.workspace.openTextDocument(uri);
    return { uri, doc, done: () => result };
  };
  const lenses = async (uri) => (await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri)) || [];

  console.log('\nEditor harness — inline review in a real VS Code\n');

  await scenario('propose: hunks land red above green, with Accept/Reject lenses', async (file) => {
    fs.writeFileSync(file, BASE);
    const { uri, doc } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    const lines = doc.getText().split('\n');
    assert.equal(lines[2], 'import c');
    assert.deepEqual(lines.slice(5, 7), ['  return 1;', '  return 42;']);
    const titles = (await until(async () => { const l = await lenses(uri); return l.length ? l : null; }, 'code lenses')).map((l) => l.command && l.command.title);
    assert.ok(titles.includes('✓ Accept') && titles.includes('✗ Reject') && titles.includes('Accept all'), `lenses: ${titles.join(', ')}`);
    assert.equal(titles.filter((t) => t === '✓ Accept').length, 2);
    assert.ok(review.isReviewing(uri));
    // Optional: hold the review on screen so the host can capture the display.
    if (process.env.NCL_EDITOR_SHOT) {
      await sleep(1500);
      fs.writeFileSync(process.env.NCL_EDITOR_SHOT, 'ready');
      await sleep(2500);
    }
  });

  await scenario('propose: accept one, reject one, through the lens commands — file saved with exactly that', async (file) => {
    fs.writeFileSync(file, BASE);
    const { uri, done } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    const ls = await until(async () => { const l = await lenses(uri); return l.length ? l : null; }, 'code lenses');
    const acceptFirst = ls.find((l) => l.command.title === '✓ Accept');
    await vscode.commands.executeCommand(acceptFirst.command.command, ...acceptFirst.command.arguments);
    const ls2 = await lenses(uri);
    const rejectNext = ls2.find((l) => l.command.title === '✗ Reject');
    await vscode.commands.executeCommand(rejectNext.command.command, ...rejectNext.command.arguments);
    await until(() => done(), 'review to finish');
    assert.deepEqual(done(), { accepted: 1, rejected: 1, conflicts: 0, applied: 0, abandoned: false });
    assert.equal(fs.readFileSync(file, 'utf8'), BASE.replace('import b\n', 'import b\nimport c\n'), 'saved to disk');
    assert.ok(!review.isReviewing(uri));
  });

  await scenario('blocks follow the developer typing above them; the cursor command resolves the right hunk', async (file) => {
    fs.writeFileSync(file, BASE);
    const { uri, doc, done } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    const ed = await vscode.window.showTextDocument(doc);
    await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// one\n// two\n'));
    // The "return" block moved from line 5 down to 7: put the cursor on its green line and accept.
    const line = doc.getText().split('\n').indexOf('  return 42;');
    assert.equal(line, 8);
    ed.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand('nanoclaw.review.accept');
    assert.ok(!doc.getText().includes('  return 1;'), 'old line removed');
    assert.ok(doc.getText().includes('import c'), 'the other hunk is untouched');
    await vscode.commands.executeCommand('nanoclaw.review.rejectAll', uri.toString());
    await until(() => done(), 'review to finish');
    assert.equal(doc.getText(), '// one\n// two\n' + BASE.replace('return 1;', 'return 42;'));
  });

  await scenario('undo ends the review rather than leaving decorations on the wrong lines', async (file) => {
    fs.writeFileSync(file, BASE);
    const { uri, doc, done } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('undo');
    await until(() => done(), 'review to end on undo');
    assert.equal(done().abandoned, true);
    assert.ok(!review.isReviewing(uri));
    assert.equal((await lenses(uri)).length, 0);
  });

  await scenario('withdraw (the panel decided the file): proposed lines leave the editor, the file is as it was, nothing counted', async (file) => {
    fs.writeFileSync(file, BASE);
    const { uri, doc, done } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    assert.notEqual(doc.getText(), BASE);
    await review.withdraw(uri);
    assert.equal(doc.getText(), BASE);
    assert.equal(doc.isDirty, false);
    assert.equal(fs.readFileSync(file, 'utf8'), BASE);
    assert.ok(!review.isReviewing(uri));
    assert.equal((await lenses(uri)).length, 0);
    assert.ok(done() && done().abandoned, 'withdraw is not a decision');
  });

  await scenario('each decision is on disk as it is made; the end leaves the editor clean', async (file) => {
    fs.writeFileSync(file, BASE);
    const { uri, doc, done } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    await vscode.commands.executeCommand('nanoclaw.review.accept', uri.toString(), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), BASE.replace('import b\n', 'import b\nimport c\n'));
    assert.ok(review.isReviewing(uri));
    await vscode.commands.executeCommand('nanoclaw.review.reject', uri.toString(), 0);
    await until(() => done(), 'review to finish');
    assert.equal(fs.readFileSync(file, 'utf8'), BASE.replace('import b\n', 'import b\nimport c\n'));
    await until(() => !doc.isDirty, 'the editor to be clean');
    assert.equal(doc.getText(), fs.readFileSync(file, 'utf8'));
  });

  await scenario('after a decision the cursor is on the next change, wrapping past the last', async (file) => {
    const base = 'a\nb\nc\nd\ne\nf\n';
    const proposal = 'A\nb\nC\nd\nE\nf\n';
    fs.writeFileSync(file, base);
    const { uri } = await startReview(file, (cur) => planPropose(base, proposal, cur));
    const ed = vscode.window.activeTextEditor;
    // Blocks at lines 0, 3 and 6 (each: old line, then new line).
    await vscode.commands.executeCommand('nanoclaw.review.accept', uri.toString(), 1);
    assert.equal(ed.selection.active.line, 5); // the third change, a line up now the old line above it is gone
    await vscode.commands.executeCommand('nanoclaw.review.reject', uri.toString(), 1);
    assert.equal(ed.selection.active.line, 0); // past the last: back to the first
    await review.withdraw(uri);
  });

  await scenario('next and previous change move between hunks, wrapping', async (file) => {
    fs.writeFileSync(file, BASE);
    const { uri } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    const ed = vscode.window.activeTextEditor;
    const at = (line) => (ed.selection = new vscode.Selection(line, 0, line, 0));
    const line = () => ed.selection.active.line;
    at(0);
    await vscode.commands.executeCommand('nanoclaw.review.next');
    assert.equal(line(), 2); // the inserted import
    await vscode.commands.executeCommand('nanoclaw.review.next');
    assert.equal(line(), 5); // return 1 / return 42
    await vscode.commands.executeCommand('nanoclaw.review.previous');
    assert.equal(line(), 2);
    await vscode.commands.executeCommand('nanoclaw.review.previous');
    assert.equal(line(), 5); // wraps to the last
    await vscode.commands.executeCommand('nanoclaw.review.jump', uri.toString(), 0);
    assert.equal(line(), 2);
    await review.withdraw(uri);
  });

  await scenario('conflicts a merged Apply left: listed, Next / Previous move between them, gone once resolved and saved', async (file) => {
    const block = (a, b) => `<<<<<<< yours\n${a}\n=======\n${b}\n>>>>>>> agent\n`;
    fs.writeFileSync(file, `top\n${block('mine 1', 'agent 1')}middle\n${block('mine 2', 'agent 2')}end\n`);
    conflicts.add([file]);
    assert.equal(conflicts.has(file), true);
    await conflicts.open(file);
    const ed = vscode.window.activeTextEditor;
    assert.equal(ed.document.uri.fsPath, file);
    assert.equal(ed.selection.active.line, 1); // the first block
    await vscode.commands.executeCommand('nanoclaw.review.next');
    assert.equal(ed.selection.active.line, 7); // the second
    await vscode.commands.executeCommand('nanoclaw.review.previous');
    assert.equal(ed.selection.active.line, 1);
    // Resolved in the editor but not saved: still listed.
    await ed.edit((e) => e.replace(new vscode.Range(0, 0, ed.document.lineCount, 0), 'top\nagent 1\nmiddle\nagent 2\nend\n'));
    assert.equal(conflicts.has(file), true);
    await ed.document.save();
    await until(() => !conflicts.has(file), 'the file to leave the conflict list once saved');
  });

  await scenario('a file that already has the changes reviews as done, not as a conflict', async (file) => {
    fs.writeFileSync(file, PROPOSAL);
    const { uri, done } = await startReview(file, (cur) => planPropose(BASE, PROPOSAL, cur));
    await until(() => done(), 'review to finish');
    assert.deepEqual(done(), { accepted: 0, rejected: 0, conflicts: 0, applied: 2, abandoned: false });
    assert.ok(!review.isReviewing(uri));
  });

  await scenario('CRLF file, no final newline: accept all is exact', async (file) => {
    const crlf = (s) => s.replace(/\n/g, '\r\n').replace(/\r\n$/, '');
    fs.writeFileSync(file, crlf(BASE));
    const { uri, done } = await startReview(file, (cur) => planPropose(crlf(BASE), crlf(PROPOSAL), cur));
    await vscode.commands.executeCommand('nanoclaw.review.acceptAll', uri.toString());
    await until(() => done(), 'review to finish');
    assert.equal(fs.readFileSync(file, 'utf8'), crlf(PROPOSAL));
  });

  console.log(`\n${failures.length ? `\x1b[31m${failures.length} failed\x1b[0m` : 'all passed'}\n`);
  if (failures.length) throw new Error(`${failures.length} editor scenario(s) failed`);
};
