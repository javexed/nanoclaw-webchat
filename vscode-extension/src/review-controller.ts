// Inline review in the editor: the agent's changes laid into the real file as
// red (old) and green (new) lines, with Accept / Reject above each hunk — the
// Cursor / Copilot shape, built from what VS Code gives an extension
// (edits, whole-line decorations, CodeLens). The rules live in
// inline-review.ts; this file only applies them to documents.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import * as vscode from 'vscode';

import {
  adjustBlocks,
  blockAt,
  decidedText,
  resolveBlock,
  splitLines,
  type Block,
  type ReviewPlan,
} from './inline-review.js';

export interface ReviewResult {
  accepted: number;
  rejected: number;
  /** Hunks that could not be placed inline (the file moved on); still in the proposal. */
  conflicts: number;
  /** Hunks the file already carried: nothing to decide. */
  applied: number;
  /** The review ended without every hunk decided (undo, closed, cancelled). */
  abandoned: boolean;
}

interface Session {
  uri: vscode.Uri;
  blocks: Block[];
  wasDirty: boolean;
  accepted: number;
  rejected: number;
  conflicts: number;
  applied: number;
  /**
   * Each decision goes to disk as it is made (the file was saved and plain
   * UTF-8 when the review began): Git shows progress, and a lost review loses
   * nothing decided. `bom` is restored on write.
   */
  writeThrough: boolean;
  bom: boolean;
  /** The disk was written: the end reloads the editor from it rather than saving over it. */
  wrote: boolean;
  onDone: (r: ReviewResult) => void;
}

/** A session as kept across a window reload: restored only onto the very text it was saved with. */
interface SavedSession {
  blocks: Block[];
  wasDirty: boolean;
  accepted: number;
  rejected: number;
  conflicts: number;
  applied: number;
  writeThrough: boolean;
  bom: boolean;
  wrote: boolean;
  hash: string;
}

const SAVED = 'nanoclaw.reviews';

const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

export class ReviewController implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  /** Our own edits must not be read as the developer typing. */
  private applying = 0;
  private readonly lenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lenses.event;
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    textDecoration: 'line-through',
    opacity: '0.75',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  private readonly disposables: vscode.Disposable[] = [];
  /** Saved sessions whose document has not opened since the reload. */
  private readonly pending = new Map<string, SavedSession>();
  private resume: ((uri: vscode.Uri) => (r: ReviewResult) => void) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  /** `store` keeps sessions across a window reload (workspace state); without it they last as long as the window. */
  constructor(
    private readonly log: (line: string) => void,
    private readonly store?: vscode.Memento,
  ) {
    this.status.command = 'nanoclaw.review.next';
    this.disposables.push(
      this.removed,
      this.added,
      this.lenses,
      this.status,
      vscode.workspace.onDidOpenTextDocument((d) => this.restoreInto(d)),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        const s = this.sessions.get(d.uri.toString());
        if (s) this.end(s, true);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintAll()),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.setContext();
        this.showStatus();
      }),
      vscode.commands.registerCommand('nanoclaw.review.accept', (uri?: string, index?: number) =>
        this.decideCmd('accept', uri, index),
      ),
      vscode.commands.registerCommand('nanoclaw.review.reject', (uri?: string, index?: number) =>
        this.decideCmd('reject', uri, index),
      ),
      vscode.commands.registerCommand('nanoclaw.review.acceptAll', (uri?: string) => this.allCmd('accept', uri)),
      vscode.commands.registerCommand('nanoclaw.review.rejectAll', (uri?: string) => this.allCmd('reject', uri)),
      vscode.commands.registerCommand('nanoclaw.review.next', () => this.next()),
      vscode.commands.registerCommand('nanoclaw.review.previous', () => this.previous()),
      vscode.commands.registerCommand('nanoclaw.review.jump', (uri: string, index: number) => this.jump(uri, index)),
    );
  }

  /**
   * Take back the reviews a window reload interrupted. The editor restores
   * the unsaved text (both versions of every open hunk); this restores the
   * blocks over it, when the text is exactly what was saved. `resume` gives
   * each one back its onDone.
   */
  restore(resume: (uri: vscode.Uri) => (r: ReviewResult) => void): void {
    this.resume = resume;
    for (const [uri, saved] of Object.entries(this.store?.get<Record<string, SavedSession>>(SAVED) ?? {})) {
      this.pending.set(uri, saved);
    }
    for (const d of vscode.workspace.textDocuments) this.restoreInto(d);
  }

  private restoreInto(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const saved = this.pending.get(key);
    if (!saved || !this.resume) return;
    this.pending.delete(key);
    const name = vscode.workspace.asRelativePath(doc.uri);
    if (hashText(doc.getText()) !== saved.hash || this.sessions.has(key)) {
      void vscode.window.showWarningMessage(`Review of ${name} was lost; the file may hold both versions.`);
      this.save();
      return;
    }
    const { hash: _hash, ...state } = saved;
    this.sessions.set(key, { uri: doc.uri, ...state, onDone: this.resume(doc.uri) });
    this.paintAll();
    this.setContext();
    this.log(`review: ${name} — resumed, ${saved.blocks.length} change(s) left`);
  }

  isReviewing(uri: vscode.Uri): boolean {
    return this.sessions.has(uri.toString());
  }

  /**
   * Open `uri` and lay the plan into it. `makePlan` receives the document's
   * current text — what the developer has open, unsaved edits included.
   */
  async start(
    uri: vscode.Uri,
    makePlan: (current: string) => ReviewPlan,
    onDone: (r: ReviewResult) => void,
    /** Opens the proposal beside the developer's file: where changes that could not be placed are taken by hand. */
    compare?: () => void,
  ): Promise<void> {
    const existing = this.sessions.get(uri.toString());
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (existing) {
      this.reveal(editor, existing.blocks[0]);
      return;
    }
    const text = doc.getText();
    const plan = makePlan(text);
    if (plan.blocks.length === 0) {
      const name = vscode.workspace.asRelativePath(uri);
      if (plan.conflicts.length) {
        const done = plan.applied.length ? ` ${plan.applied.length} already in.` : '';
        void this.setAside(name, plan.conflicts.length, compare, done);
      } else if (plan.applied.length && doc.isDirty) {
        void vscode.window.showInformationMessage(`${name} has the changes, unsaved.`, 'Save').then((pick) => {
          if (pick === 'Save') void doc.save();
        });
      } else {
        void vscode.window.showInformationMessage(
          plan.applied.length ? `${name} has the changes.` : 'Nothing to review.',
        );
      }
      onDone({
        accepted: 0,
        rejected: 0,
        conflicts: plan.conflicts.length,
        applied: plan.applied.length,
        abandoned: plan.conflicts.length > 0,
      });
      return;
    }
    const session: Session = {
      uri,
      blocks: plan.blocks,
      wasDirty: doc.isDirty,
      accepted: 0,
      rejected: 0,
      conflicts: plan.conflicts.length,
      applied: plan.applied.length,
      ...writable(doc),
      wrote: false,
      onDone,
    };
    const { eol } = splitLines(text);
    const lines = splitLines(text).lines.length;
    const trailing = text.endsWith('\n');
    const edit = new vscode.WorkspaceEdit();
    for (const ins of plan.inserts) {
      const body = ins.lines.join(eol);
      // Mirrors applyInserts() in the tests: an empty file, or a line inside the file (or the
      // empty line after a final newline), takes "lines + eol" at column 0; a
      // file without a final newline takes "eol + lines" at its very end.
      if (text === '' || ins.line < lines || trailing) edit.insert(uri, new vscode.Position(ins.line, 0), body + eol);
      else edit.insert(uri, doc.lineAt(doc.lineCount - 1).range.end, eol + body);
    }
    this.sessions.set(uri.toString(), session);
    await this.apply(edit);
    this.save();
    this.paintAll();
    this.setContext();
    this.reveal(editor, session.blocks[0]);
    if (session.conflicts) void this.setAside(vscode.workspace.asRelativePath(uri), session.conflicts, compare);
    this.log(
      `review: ${vscode.workspace.asRelativePath(uri)} — ${session.blocks.length} change(s) inline, ${session.conflicts} set aside`,
    );
  }

  /** Changes whose lines read differently in the developer's file: said plainly, with the way to take them by hand. */
  private async setAside(name: string, n: number, compare?: () => void, prefix = ''): Promise<void> {
    const text = `${name}:${prefix} ${n} change(s) not shown: those lines in your file differ from the agent's starting point.`;
    const pick = await vscode.window.showWarningMessage(text.trim(), ...(compare ? ['Compare'] : []));
    if (pick === 'Compare') compare?.();
  }

  // ---- decisions ------------------------------------------------------------------

  /** `advance`: move on to the change after this one (not for Accept / Reject all, which decide them all). */
  async decide(uri: vscode.Uri, index: number, decision: 'accept' | 'reject', advance = true): Promise<void> {
    const s = this.sessions.get(uri.toString());
    if (!s || index < 0 || index >= s.blocks.length) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const r = resolveBlock(s.blocks, index, decision);
    if (r.deleteCount > 0) {
      const edit = new vscode.WorkspaceEdit();
      edit.delete(uri, lineRange(doc, r.deleteStart, r.deleteCount));
      await this.apply(edit);
    }
    s.blocks = r.blocks;
    if (decision === 'accept') s.accepted++;
    else s.rejected++;
    if (s.blocks.length === 0) {
      await this.end(s, false);
      return;
    }
    if (s.writeThrough) this.writeDisk(s, decidedText(doc.getText(), s.blocks));
    this.save();
    this.paintAll();
    // The change after the one decided now has its index; past the last, the first.
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (advance && ed) this.reveal(ed, s.blocks[index < s.blocks.length ? index : 0]);
  }

  /**
   * Take a review back out of the editor without deciding anything: the
   * panel applied or rejected the file itself (or it left the proposal), and
   * its proposed lines must not stay behind in the open document. Pending
   * hunks are removed — the file is as it was, plus any hunk already accepted.
   */
  async withdraw(uri: vscode.Uri): Promise<void> {
    const s = this.sessions.get(uri.toString());
    if (!s) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    // Bottom-up, so each deletion leaves the blocks above it where they are.
    while (s.blocks.length) {
      const r = resolveBlock(s.blocks, s.blocks.length - 1, 'reject');
      if (r.deleteCount > 0) {
        const edit = new vscode.WorkspaceEdit();
        edit.delete(uri, lineRange(doc, r.deleteStart, r.deleteCount));
        await this.apply(edit);
      }
      s.blocks = r.blocks;
    }
    // It was clean before the review: leave it clean, not dirty with a no-op.
    if (!s.wasDirty) await this.settle(s, doc);
    await this.end(s, true);
  }

  /** The files under review now. */
  reviewing(): vscode.Uri[] {
    return [...this.sessions.values()].map((s) => s.uri);
  }

  private async decideCmd(decision: 'accept' | 'reject', uri?: string, index?: number): Promise<void> {
    if (uri !== undefined && index !== undefined) return this.decide(vscode.Uri.parse(uri), index, decision);
    const ed = vscode.window.activeTextEditor;
    const s = ed && this.sessions.get(ed.document.uri.toString());
    if (!ed || !s) return;
    const k = blockAt(s.blocks, ed.selection.active.line);
    if (k >= 0) await this.decide(ed.document.uri, k, decision);
    else void vscode.window.setStatusBarMessage('Cursor is not in a change.', 3000);
  }

  private async allCmd(decision: 'accept' | 'reject', uri?: string): Promise<void> {
    const target = uri ? vscode.Uri.parse(uri) : vscode.window.activeTextEditor?.document.uri;
    const s = target && this.sessions.get(target.toString());
    if (!target || !s) return;
    // Bottom-up, so each deletion leaves the blocks above it where they are.
    while (s.blocks.length) await this.decide(target, s.blocks.length - 1, decision, false);
  }

  private async next(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const s = ed && this.sessions.get(ed.document.uri.toString());
    // No review here: a file a merged Apply left conflicts in — the same keys go between those.
    if (!s) return void (await vscode.commands.executeCommand('merge-conflict.next'));
    if (!ed || !s.blocks.length) return;
    const line = ed.selection.active.line;
    const b = s.blocks.find((x) => x.removedStart > line) ?? s.blocks[0];
    this.reveal(ed, b);
  }

  /** A lens click: the cursor is not in the change it sits on, so go by index. */
  private jump(uri: string, index: number): void {
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
    const s = this.sessions.get(uri);
    if (ed && s) this.reveal(ed, s.blocks[index]);
  }

  private async previous(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const s = ed && this.sessions.get(ed.document.uri.toString());
    if (!s) return void (await vscode.commands.executeCommand('merge-conflict.previous'));
    if (!ed || !s.blocks.length) return;
    const line = ed.selection.active.line;
    const k = blockAt(s.blocks, line);
    const before = k >= 0 ? s.blocks.slice(0, k) : s.blocks.filter((x) => x.addedStart + x.addedCount <= line);
    this.reveal(ed, before[before.length - 1] ?? s.blocks[s.blocks.length - 1]);
  }

  private async end(s: Session, abandoned: boolean): Promise<void> {
    this.sessions.delete(s.uri.toString());
    this.save();
    this.paintAll();
    this.setContext();
    if (!abandoned) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === s.uri.toString());
      if (!s.wasDirty) await (doc && this.settle(s, doc));
      else if (doc?.isDirty) {
        const name = vscode.workspace.asRelativePath(s.uri);
        void vscode.window.showInformationMessage(`${name} reviewed, unsaved.`, 'Save').then((pick) => {
          if (pick === 'Save') void doc.save();
        });
      }
    }
    s.onDone({
      accepted: s.accepted,
      rejected: s.rejected,
      conflicts: s.conflicts,
      applied: s.applied,
      abandoned: abandoned || s.blocks.length > 0,
    });
  }

  // ---- writing through --------------------------------------------------------------

  private writeDisk(s: Session, text: string): void {
    try {
      fs.writeFileSync(s.uri.fsPath, (s.bom ? '\uFEFF' : '') + text);
      s.wrote = true;
    } catch (err) {
      // Not fatal: the decisions stay in the editor and are saved at the end.
      s.writeThrough = false;
      this.log(`review: could not write ${s.uri.fsPath} as you go: ${String((err as Error).message)}`);
    }
  }

  /**
   * The review is over and the editor holds exactly the decided file. Saved
   * as usual when the disk was never touched; otherwise the disk takes the
   * text and the editor reloads from it — a save would stop on "the file is
   * newer", since we wrote it behind the editor's back.
   */
  private async settle(s: Session, doc: vscode.TextDocument): Promise<void> {
    if (!s.wrote) {
      await doc.save();
      return;
    }
    this.writeDisk(s, doc.getText());
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }

  // ---- surviving a reload -----------------------------------------------------------

  /** Keep the sessions in workspace state, each with the text its blocks sit on. */
  private save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.store) return;
    const out: Record<string, SavedSession> = Object.fromEntries(this.pending);
    for (const [key, s] of this.sessions) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
      if (!doc) continue;
      out[key] = {
        blocks: s.blocks,
        wasDirty: s.wasDirty,
        accepted: s.accepted,
        rejected: s.rejected,
        conflicts: s.conflicts,
        applied: s.applied,
        writeThrough: s.writeThrough,
        bom: s.bom,
        wrote: s.wrote,
        hash: hashText(doc.getText()),
      };
    }
    void this.store.update(SAVED, Object.keys(out).length ? out : undefined);
  }

  /** While the developer types: once they pause. */
  private saveSoon(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 300);
  }

  // ---- keeping blocks on their lines ------------------------------------------------

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    if (this.applying > 0 || e.contentChanges.length === 0) return;
    const s = this.sessions.get(e.document.uri.toString());
    if (!s) return;
    // Undo/redo can take our inserted lines back out from under the blocks.
    // There is no sound way to follow that: end the review, keep the text.
    if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
      void vscode.window.showWarningMessage(
        'Review ended by undo; both versions remain. Review again or tidy by hand.',
      );
      void this.end(s, true);
      return;
    }
    // Content changes arrive in document order within one event; apply bottom-up.
    const changes = [...e.contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);
    for (const c of changes) {
      const added = (c.text.match(/\n/g) ?? []).length;
      const removed = c.range.end.line - c.range.start.line;
      s.blocks = adjustBlocks(s.blocks, c.range.start.line, c.range.end.line, added - removed);
    }
    this.saveSoon();
    this.paintAll();
  }

  private async apply(edit: vscode.WorkspaceEdit): Promise<void> {
    this.applying++;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.applying--;
    }
  }

  // ---- painting ---------------------------------------------------------------------

  private paintAll(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      const s = this.sessions.get(ed.document.uri.toString());
      const red: vscode.Range[] = [];
      const green: vscode.Range[] = [];
      for (const b of s?.blocks ?? []) {
        if (b.removedCount) red.push(new vscode.Range(b.removedStart, 0, b.removedStart + b.removedCount - 1, 0));
        if (b.addedCount) green.push(new vscode.Range(b.addedStart, 0, b.addedStart + b.addedCount - 1, 0));
      }
      ed.setDecorations(this.removed, red);
      ed.setDecorations(this.added, green);
    }
    this.lenses.fire();
    this.showStatus();
  }

  /** How many changes are left in the file in front of the developer; it saves when none are. */
  private showStatus(): void {
    const ed = vscode.window.activeTextEditor;
    const s = ed && this.sessions.get(ed.document.uri.toString());
    if (!s) {
      this.status.hide();
      return;
    }
    this.status.text = `$(diff) ${s.blocks.length} left`;
    this.status.tooltip = s.writeThrough
      ? 'Changes left to accept or reject. Each decision is saved as you go.'
      : s.wasDirty
        ? 'Changes left to accept or reject. The file had unsaved edits: save it yourself when done.'
        : 'Changes left to accept or reject. The file saves when none are left.';
    this.status.show();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.sessions.get(doc.uri.toString());
    if (!s) return [];
    const out: vscode.CodeLens[] = [];
    const uri = doc.uri.toString();
    s.blocks.forEach((b, k) => {
      const line = Math.min(b.removedStart, Math.max(0, doc.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      if (k === 0 && s.blocks.length > 1) {
        out.push(new vscode.CodeLens(range, { title: `${s.blocks.length} changes`, command: '' }));
        out.push(
          new vscode.CodeLens(range, { title: 'Accept all', command: 'nanoclaw.review.acceptAll', arguments: [uri] }),
        );
        out.push(
          new vscode.CodeLens(range, { title: 'Reject all', command: 'nanoclaw.review.rejectAll', arguments: [uri] }),
        );
      }
      out.push(
        new vscode.CodeLens(range, {
          title: '✓ Accept',
          tooltip: 'Keep the new lines (Ctrl+Alt+Enter)',
          command: 'nanoclaw.review.accept',
          arguments: [uri, k],
        }),
      );
      out.push(
        new vscode.CodeLens(range, {
          title: '✗ Reject',
          tooltip: 'Keep the old lines (Ctrl+Alt+Backspace)',
          command: 'nanoclaw.review.reject',
          arguments: [uri, k],
        }),
      );
      if (s.blocks.length > 1) {
        out.push(
          new vscode.CodeLens(range, {
            title: '↓ Next',
            tooltip: 'Next change (Alt+F5); previous: Shift+Alt+F5',
            command: 'nanoclaw.review.jump',
            arguments: [uri, (k + 1) % s.blocks.length],
          }),
        );
      }
    });
    return out;
  }

  private reveal(ed: vscode.TextEditor, b: Block | undefined): void {
    if (!b) return;
    const pos = new vscode.Position(b.removedStart, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(
      new vscode.Range(pos, new vscode.Position(b.addedStart + b.addedCount, 0)),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  private setContext(): void {
    const ed = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand(
      'setContext',
      'nanoclaw.reviewing',
      !!ed && this.sessions.has(ed.document.uri.toString()),
    );
  }

  dispose(): void {
    // A reload: write down where the review stands before the window goes.
    if (this.saveTimer) this.save();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * The document range covering lines [start, start+count) — mirrors the
 * tests' deleteLines(): through the last line of a file without a final newline, the
 * preceding line break goes too, so no empty line is left behind.
 */
function lineRange(doc: vscode.TextDocument, start: number, count: number): vscode.Range {
  const text = doc.getText();
  const real = splitLines(text).lines.length;
  const trailing = text.endsWith('\n');
  if (start + count < real) return new vscode.Range(start, 0, start + count, 0);
  if (trailing) return new vscode.Range(start, 0, real, 0);
  if (start === 0) return new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
  return new vscode.Range(
    start - 1,
    doc.lineAt(start - 1).text.length,
    doc.lineCount - 1,
    doc.lineAt(doc.lineCount - 1).text.length,
  );
}

/** Whether decisions can go straight to disk: a saved file on disk that reads back as UTF-8 byte for byte. */
function writable(doc: vscode.TextDocument): { writeThrough: boolean; bom: boolean } {
  if (doc.isDirty || doc.uri.scheme !== 'file') return { writeThrough: false, bom: false };
  try {
    const bytes = fs.readFileSync(doc.uri.fsPath);
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = bytes.toString('utf8');
    const same = Buffer.from(text, 'utf8').equals(bytes) && (bom ? text.slice(1) : text) === doc.getText();
    return { writeThrough: same, bom };
  } catch {
    return { writeThrough: false, bom: false };
  }
}
