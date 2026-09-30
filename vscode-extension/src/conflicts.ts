// Files a merged Apply left conflict blocks in. Apply takes a file out of the
// proposal, so without this an empty proposal read as "nothing left to do"
// while the file still held both versions. A file stays listed until its
// saved text has no blocks left — checked on every save and at startup, so it
// survives a reload — and while one is in front of the developer the status
// bar counts its blocks and Next / Previous change move between them.
import fs from 'node:fs';
import * as vscode from 'vscode';

import { conflictBlocks } from './inline-review.js';

const SAVED = 'nanoclaw.conflicts';

export class ConflictTracker implements vscode.Disposable {
  /** Absolute path → blocks in the saved file. */
  private readonly files = new Map<string, number>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  private readonly disposables: vscode.Disposable[] = [];
  private readonly listeners: Array<() => void> = [];

  constructor(private readonly store?: vscode.Memento) {
    this.status.command = 'nanoclaw.review.next';
    this.disposables.push(
      this.status,
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (this.files.has(d.uri.fsPath)) this.check(d.uri.fsPath, d.getText());
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.files.has(e.document.uri.fsPath)) this.show();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.show()),
    );
    for (const file of this.store?.get<string[]>(SAVED) ?? []) this.check(file);
  }

  /** Called when the list changes. */
  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Files Apply just merged with conflicts. */
  add(files: string[]): void {
    for (const f of files) this.check(f);
  }

  /** Listed files under `root`, with their blocks. */
  under(root: string): Array<{ path: string; blocks: number }> {
    const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}${root.includes('\\') ? '\\' : '/'}`;
    return [...this.files]
      .filter(([f]) => f.startsWith(prefix))
      .map(([f, blocks]) => ({ path: f.slice(prefix.length).split('\\').join('/'), blocks }));
  }

  has(file: string): boolean {
    return this.files.has(file);
  }

  /** Open `file` at its first conflict. */
  async open(file: string): Promise<void> {
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    const top = new vscode.Position(0, 0);
    ed.selection = new vscode.Selection(top, top);
    await vscode.commands.executeCommand('merge-conflict.next');
  }

  private check(file: string, text?: string): void {
    let blocks = 0;
    try {
      blocks = conflictBlocks(text ?? fs.readFileSync(file, 'utf8'));
    } catch {
      // gone or unreadable: nothing left to resolve there
    }
    const before = this.files.get(file);
    if (blocks) this.files.set(file, blocks);
    else this.files.delete(file);
    if (before === (blocks || undefined)) return this.show();
    void this.store?.update(SAVED, this.files.size ? [...this.files.keys()] : undefined);
    this.show();
    for (const fn of this.listeners) fn();
  }

  /** The file in front of the developer: its blocks as it reads now, unsaved edits included. */
  private show(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const listed = !!doc && this.files.has(doc.uri.fsPath);
    const now = listed ? conflictBlocks(doc.getText()) : 0;
    void vscode.commands.executeCommand('setContext', 'nanoclaw.conflicted', now > 0);
    if (!listed) {
      this.status.hide();
      return;
    }
    this.status.text = now ? `$(warning) ${now} conflict${now === 1 ? '' : 's'}` : '$(save) Save';
    this.status.tooltip = now
      ? 'Conflicts left to resolve: where you and the agent changed the same lines. Next: Alt+F5.'
      : 'Resolved; save the file to finish.';
    this.status.command = now ? 'nanoclaw.review.next' : 'workbench.action.files.save';
    this.status.show();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
