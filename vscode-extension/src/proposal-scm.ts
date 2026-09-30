// The agent's proposal in the Source Control view, beside Git: the files it
// changed in its copy, each with Review / Apply / Reject, and Apply all on the
// title bar. Applied files leave this list and show up in Git's, ready to
// commit. The chat panel keeps the same list; this is where a developer looks.
import path from 'node:path';
import * as vscode from 'vscode';

import type { ProposedFile } from './git-changes.js';

/** What the proposal list can do; the chat panel implements it. */
export interface ProposalActions {
  diff: (rel: string) => Promise<void>;
  review: (rel: string) => Promise<void>;
  reviewAll: () => Promise<void>;
  act: (what: 'apply' | 'reject', rels?: string[]) => Promise<void>;
  refresh: () => Promise<void>;
  /** Open a file a merged Apply left conflicts in, at the first one. */
  openConflict: (rel: string) => Promise<void>;
}

const ICON: Record<ProposedFile['status'], string> = { M: 'diff-modified', A: 'diff-added', D: 'diff-removed' };
const WORD: Record<ProposedFile['status'], string> = { M: 'Modified', A: 'Added', D: 'Deleted' };

export class ProposalScm implements vscode.Disposable {
  private scm: vscode.SourceControl | null = null;
  private group: vscode.SourceControlResourceGroup | null = null;
  private conflictGroup: vscode.SourceControlResourceGroup | null = null;
  private root = '';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly actions: ProposalActions) {
    const one =
      (fn: (rel: string) => Promise<void>) =>
      (...states: unknown[]) => {
        for (const rel of this.rels(states)) void fn(rel);
      };
    this.disposables.push(
      vscode.commands.registerCommand('nanoclaw.proposal.diff', one(actions.diff)),
      vscode.commands.registerCommand('nanoclaw.proposal.review', one(actions.review)),
      vscode.commands.registerCommand('nanoclaw.proposal.apply', (...s: unknown[]) => this.act('apply', s)),
      vscode.commands.registerCommand('nanoclaw.proposal.reject', (...s: unknown[]) => this.act('reject', s)),
      vscode.commands.registerCommand('nanoclaw.proposal.applyAll', () => actions.act('apply')),
      vscode.commands.registerCommand('nanoclaw.proposal.rejectAll', () => actions.act('reject')),
      vscode.commands.registerCommand('nanoclaw.proposal.reviewAll', () => actions.reviewAll()),
      vscode.commands.registerCommand('nanoclaw.proposal.refresh', () => actions.refresh()),
      vscode.commands.registerCommand('nanoclaw.conflict.open', one(actions.openConflict)),
    );
  }

  /**
   * Show `files` (paths relative to `repoRoot`), and the files a merged Apply
   * left conflicts in; no proposal hides the provider.
   */
  update(
    repoRoot: string | null,
    files: ProposedFile[],
    reviewable: (f: ProposedFile) => boolean,
    conflicts: Array<{ path: string; blocks: number }> = [],
  ): void {
    if (!repoRoot) {
      this.close();
      return;
    }
    if (!this.scm || this.root !== repoRoot) {
      this.close();
      this.root = repoRoot;
      this.scm = vscode.scm.createSourceControl('nanoclaw', 'NanoClaw', vscode.Uri.file(repoRoot));
      this.scm.inputBox.visible = false;
      // Conflicts first: a file there is further along — only it is left to finish.
      this.conflictGroup = this.scm.createResourceGroup('conflicts', 'Conflicts');
      this.conflictGroup.hideWhenEmpty = true;
      this.group = this.scm.createResourceGroup('proposed', 'Proposed');
      this.group.hideWhenEmpty = true;
    }
    this.conflictGroup!.resourceStates = conflicts.map((c) => ({
      resourceUri: vscode.Uri.file(path.join(repoRoot, c.path)),
      contextValue: 'conflict',
      command: { title: 'Next conflict', command: 'nanoclaw.conflict.open', arguments: [c.path] },
      decorations: {
        iconPath: new vscode.ThemeIcon('warning'),
        tooltip: `${c.blocks} conflict${c.blocks === 1 ? '' : 's'} to resolve`,
      },
    }));
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    this.group!.resourceStates = sorted.map((f) => ({
      resourceUri: vscode.Uri.file(path.join(repoRoot, f.path)),
      contextValue: reviewable(f) ? 'reviewable' : 'proposed',
      command: { title: 'Open Diff', command: 'nanoclaw.proposal.diff', arguments: [f.path] },
      decorations: {
        iconPath: new vscode.ThemeIcon(ICON[f.status]),
        strikeThrough: f.status === 'D',
        tooltip: f.risk ? `${WORD[f.status]} — ${f.risk}` : WORD[f.status],
      },
    }));
    this.scm!.count = files.length + conflicts.length;
    void vscode.commands.executeCommand('setContext', 'nanoclaw.proposalReviewable', files.some(reviewable));
  }

  /** Apply or reject exactly the files named — never "all" by way of an empty list. */
  private async act(what: 'apply' | 'reject', args: unknown[]): Promise<void> {
    const rels = this.rels(args);
    if (rels.length) await this.actions.act(what, rels);
  }

  /**
   * The files a command names: a path (the click command), or the resource
   * states VS Code passes (the one clicked, plus the selection).
   */
  private rels(args: unknown[]): string[] {
    const out = new Set<string>();
    for (const a of args.flat()) {
      if (typeof a === 'string') out.add(a);
      else if (a && typeof a === 'object' && 'resourceUri' in a) {
        const uri = (a as vscode.SourceControlResourceState).resourceUri;
        out.add(path.relative(this.root, uri.fsPath).split(path.sep).join('/'));
      }
    }
    return [...out];
  }

  private close(): void {
    this.scm?.dispose();
    this.scm = null;
    this.group = null;
    this.conflictGroup = null;
    this.root = '';
  }

  dispose(): void {
    this.close();
    for (const d of this.disposables) d.dispose();
  }
}
