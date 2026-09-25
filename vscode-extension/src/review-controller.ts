// Inline review in the editor: the agent's changes laid into the real file as
// red (old) and green (new) lines, with Accept / Reject above each hunk — the
// Cursor / Copilot shape, built from what VS Code gives an extension
// (edits, whole-line decorations, CodeLens). The rules live in
// inline-review.ts; this file only applies them to documents.
import * as vscode from 'vscode';

import { adjustBlocks, blockAt, resolveBlock, splitLines, type Block, type ReviewPlan } from './inline-review.js';

export interface ReviewResult {
  accepted: number;
  rejected: number;
  /** Hunks that could not be placed inline (the file moved on); still in the proposal. */
  conflicts: number;
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
  onDone: (r: ReviewResult) => void;
}

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
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: (line: string) => void) {
    this.disposables.push(
      this.removed,
      this.added,
      this.lenses,
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        const s = this.sessions.get(d.uri.toString());
        if (s) this.end(s, true);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintAll()),
      vscode.window.onDidChangeActiveTextEditor(() => this.setContext()),
      vscode.commands.registerCommand('nanoclaw.review.accept', (uri?: string, index?: number) =>
        this.decideCmd('accept', uri, index),
      ),
      vscode.commands.registerCommand('nanoclaw.review.reject', (uri?: string, index?: number) =>
        this.decideCmd('reject', uri, index),
      ),
      vscode.commands.registerCommand('nanoclaw.review.acceptAll', (uri?: string) => this.allCmd('accept', uri)),
      vscode.commands.registerCommand('nanoclaw.review.rejectAll', (uri?: string) => this.allCmd('reject', uri)),
      vscode.commands.registerCommand('nanoclaw.review.next', () => this.next()),
    );
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
      void vscode.window.showInformationMessage(
        plan.conflicts.length ? `${plan.conflicts.length} change(s) no longer fit. Use Diff.` : 'Nothing to review.',
      );
      onDone({ accepted: 0, rejected: 0, conflicts: plan.conflicts.length, abandoned: plan.conflicts.length > 0 });
      return;
    }
    const session: Session = {
      uri,
      blocks: plan.blocks,
      wasDirty: doc.isDirty,
      accepted: 0,
      rejected: 0,
      conflicts: plan.conflicts.length,
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
    this.paintAll();
    this.setContext();
    this.reveal(editor, session.blocks[0]);
    if (session.conflicts) {
      void vscode.window.showWarningMessage(
        `${session.conflicts} change(s) set aside (you edited those lines). Use Diff.`,
      );
    }
    this.log(
      `review: ${vscode.workspace.asRelativePath(uri)} — ${session.blocks.length} change(s) inline, ${session.conflicts} set aside`,
    );
  }

  // ---- decisions ------------------------------------------------------------------

  async decide(uri: vscode.Uri, index: number, decision: 'accept' | 'reject'): Promise<void> {
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
    this.paintAll();
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
    while (s.blocks.length) await this.decide(target, s.blocks.length - 1, decision);
  }

  private next(): void {
    const ed = vscode.window.activeTextEditor;
    const s = ed && this.sessions.get(ed.document.uri.toString());
    if (!ed || !s || !s.blocks.length) return;
    const line = ed.selection.active.line;
    const b = s.blocks.find((x) => x.removedStart > line) ?? s.blocks[0];
    this.reveal(ed, b);
  }

  private async end(s: Session, abandoned: boolean): Promise<void> {
    this.sessions.delete(s.uri.toString());
    this.paintAll();
    this.setContext();
    if (!abandoned && !s.wasDirty) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === s.uri.toString());
      await doc?.save();
    }
    s.onDone({
      accepted: s.accepted,
      rejected: s.rejected,
      conflicts: s.conflicts,
      abandoned: abandoned || s.blocks.length > 0,
    });
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
