// The chat view inside VS Code: the developer's dedicated agent, in the
// sidebar, over the runner's own authenticated socket. Frames: we send
// `chat.open` / `chat.send`; central answers `chat.room`, `chat.message`,
// `chat.error`. Rendering happens here (escaped Markdown) so the webview's
// CSP allows no scripts but our own and no remote content at all.
//
// It also shows what the agent is doing while it works (central's status
// frames), puts Copy / Insert / New file on every code block, and carries
// files both ways: attach from the workspace, open or save what the agent sends.
//
// Two things make it a coding tool rather than a chat window:
// - every message carries an editor note — the file (and lines) the developer
//   is looking at — so "this file" means something to the agent;
// - a Proposal section shows what the agent changed in its copy of the
//   developer's tree, with a diff and Apply / Reject per file.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';

import {
  applyProposal,
  changedFiles,
  resolveWorkspace,
  proposalBaseContent,
  proposalChanges,
  rejectProposal,
  type Proposal,
  type ProposedFile,
} from './git-changes.js';
import { fileCard, safeLocalName, uploadPath, statusLine, type FileMeta } from './chat-render.js';
import { recordActivity } from './activity-log.js';
import { editorNote, splitEditorNote } from './editor-note.js';
import { planPropose, nextReviewFile } from './inline-review.js';
import type { ReviewController } from './review-controller.js';
import type { ConflictTracker } from './conflicts.js';
import { escapeHtml, renderMarkdown } from './markdown.js';

interface ChatMessage {
  id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type?: string;
  file_meta?: FileMeta | null;
  created_at: number;
}

/** What one upload may weigh: the PWA's own limit is higher, but a panel attachment is a file from the project. */
const MAX_ATTACHMENT = 100 * 1024 * 1024;

export interface ChatDeps {
  /** Push a frame to central; false when not connected. */
  send: (frame: Record<string, unknown>) => boolean;
  log: (line: string) => void;
  /** The folder bound as the agent's workspace (where attachments are picked from and saved to). */
  workspaceRoot: () => string | undefined;
  /** Scratch space for base copies shown in diffs. */
  storageRoot: () => string;
  /** The proposal clone under review, once the session has one. */
  proposal: () => Proposal | null;
  /** An authenticated call to central (bearer token, CSRF header on writes). `apiPath` starts with /api/. */
  api: (apiPath: string, init?: RequestInit) => Promise<Response>;
  /** Inline review in the editor (Accept / Reject per hunk). */
  review: ReviewController;
  /** Files a merged Apply left conflicts in, until they are resolved. */
  conflicts?: ConflictTracker;
  /** The proposal was re-read (the Source Control view shows it too). */
  proposedChanged?: (repoRoot: string | null, files: ProposedFile[]) => void;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'nanoclaw.chat';
  private view: vscode.WebviewView | null = null;
  private room: { id: string; name: string } | null = null;
  private messages: ChatMessage[] = [];
  private status = 'Not connected';
  private opened = false;
  /** Files chosen with "+ File", uploaded with the next send. */
  private pending: string[] = [];
  /** The editor a code block is inserted into: the webview has focus when its button is clicked. */
  private lastEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;

  private readonly editorWatch: vscode.Disposable;

  constructor(private readonly d: ChatDeps) {
    this.editorWatch = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e && e.document.uri.scheme !== 'output') this.lastEditor = e;
    });
    // A review a window reload interrupted finishes like any other: its file is
    // found against the proposal when the last change is decided.
    d.review.restore((uri) => (r) => {
      const root = this.d.proposal()?.repoRoot;
      if (!root) return this.d.log(`review: ${uri.fsPath} finished with no proposal open`);
      void this.reviewDone(path.relative(root, uri.fsPath).split(path.sep).join('/'), r);
    });
  }

  dispose(): void {
    this.editorWatch.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(
      (m: { type: string; text?: string; path?: string; act?: string; lang?: string; id?: string }) => {
        switch (m.type) {
          case 'ready':
            this.repaint();
            void this.refreshChanges();
            return;
          case 'send':
            if (typeof m.text === 'string') void this.sendText(m.text);
            return;
          case 'attachSelection':
            this.attachSelection();
            return;
          case 'attachFile':
            void this.pickFiles();
            return;
          case 'unattach':
            this.pending = this.pending.filter((p) => p !== m.path);
            this.postPending();
            return;
          case 'code':
            if (typeof m.text === 'string') void this.codeAction(m.act ?? '', m.text, m.lang ?? '');
            return;
          case 'file.open':
          case 'file.save':
            if (m.id) void this.fileAction(m.type === 'file.open' ? 'open' : 'save', m.id);
            return;
          case 'reopen':
            this.open(true);
            return;
          case 'changes.refresh':
            void this.refreshChanges();
            return;
          case 'changes.diff':
            if (m.path) void this.openDiff(m.path);
            return;
          case 'review':
            if (m.path) void this.reviewFile(m.path);
            return;
          case 'conflict.open':
            if (m.path) void this.openConflict(m.path);
            return;
          case 'review.all':
            void this.reviewNext();
            return;
          case 'proposal.apply':
            void this.proposalAct('apply', m.path ? [m.path] : undefined);
            return;
          case 'proposal.reject':
            void this.proposalAct('reject', m.path ? [m.path] : undefined);
            return;
        }
      },
    );
    view.onDidDispose(() => {
      this.view = null;
    });
  }

  /** Re-read the Proposal section (the runner learned of a proposal clone). */
  refresh(): void {
    void this.refreshChanges();
  }

  /** Link state changed: reflect it and (re)open the room when connected. */
  setConnected(connected: boolean, detail?: string): void {
    if (connected) {
      this.status = detail ? `Connected · ${detail}` : 'Connected';
      this.opened = false;
      this.open();
    } else {
      this.status = detail ? `Not connected · ${detail}` : 'Not connected';
      this.opened = false;
      this.post({ type: 'status', text: this.status });
      this.post({ type: 'working', text: null });
    }
  }

  open(force = false): void {
    if (this.opened && !force) return;
    if (this.d.send({ type: 'chat.open' })) this.opened = true;
  }

  /** Frames from central. Returns true when the frame was ours. */
  handleFrame(frame: Record<string, unknown>): boolean {
    switch (frame.type) {
      case 'chat.room': {
        this.room = { id: String(frame.roomId), name: String(frame.name ?? frame.roomId) };
        this.messages = Array.isArray(frame.messages) ? (frame.messages as ChatMessage[]) : [];
        this.status = `Connected · ${this.room.name}`;
        this.repaint();
        return true;
      }
      case 'chat.message': {
        const m = frame as unknown as ChatMessage;
        if (!this.messages.some((x) => x.id === m.id)) {
          this.messages.push(m);
          if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
          this.post({ type: 'message', html: this.renderOne(m) });
          // The agent answered: its copy may hold new work.
          if (m.sender_type === 'agent') void this.refreshChanges().then(() => this.offerNewWork());
        }
        return true;
      }
      case 'chat.status': {
        const line = statusLine(
          String(frame.event ?? ''),
          typeof frame.text === 'string' ? frame.text : null,
          typeof frame.detail === 'string' ? frame.detail : null,
        );
        this.post({ type: 'working', text: line, stalled: frame.event === 'stalled' });
        return true;
      }
      case 'chat.error': {
        this.post({ type: 'error', text: String(frame.message ?? 'chat error') });
        this.d.log(`chat: ${String(frame.message ?? 'error')}`);
        return true;
      }
      default:
        return false;
    }
  }

  async sendText(text: string): Promise<void> {
    let t = text.trim();
    if (!t && !this.pending.length) return;
    const note = editorNote(vscode.window.activeTextEditor, (u) =>
      vscode.workspace.asRelativePath(u as vscode.Uri, false),
    );
    if (t && note && !t.includes('(editor: ')) t = `${t}\n${note}`;
    if (this.pending.length) {
      await this.uploadPending(t);
      return;
    }
    if (!this.d.send({ type: 'chat.send', text: t })) this.post({ type: 'error', text: 'Not connected.' });
  }

  // ---- files -------------------------------------------------------------------

  private async pickFiles(): Promise<void> {
    const root = this.d.workspaceRoot();
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      ...(root ? { defaultUri: vscode.Uri.file(root) } : {}),
    });
    if (!picked?.length) return;
    for (const u of picked) {
      let size = 0;
      try {
        size = fs.statSync(u.fsPath).size;
      } catch {
        continue;
      }
      if (size > MAX_ATTACHMENT) {
        this.post({
          type: 'error',
          text: `${path.basename(u.fsPath)} is larger than ${MAX_ATTACHMENT / 1024 / 1024} MB.`,
        });
        continue;
      }
      if (!this.pending.includes(u.fsPath)) this.pending.push(u.fsPath);
    }
    this.postPending();
  }

  private postPending(): void {
    const root = this.d.workspaceRoot();
    this.post({
      type: 'pending',
      files: this.pending.map((p) => ({
        path: p,
        label: root && p.startsWith(root) ? path.relative(root, p) : path.basename(p),
      })),
    });
  }

  /**
   * Upload each attached file exactly as the PWA does, so central stores it,
   * broadcasts it and hands it to the agent (over the mailbox sync, for a
   * session on this machine). The text rides on the first file as its caption.
   */
  private async uploadPending(text: string): Promise<void> {
    if (!this.room) {
      this.post({ type: 'error', text: 'Not connected.' });
      return;
    }
    const files = [...this.pending];
    this.pending = [];
    this.postPending();
    let caption: string | undefined = text;
    for (const f of files) {
      try {
        const bytes = fs.readFileSync(f);
        const form = new FormData();
        if (caption) form.append('caption', caption);
        form.append('file', new Blob([bytes]), path.basename(f));
        const res = await this.d.api(uploadPath(this.room.id), { method: 'POST', body: form });
        if (!res.ok)
          throw new Error(
            `HTTP ${res.status}${await res.text().then(
              (t) => (t ? `: ${t.slice(0, 160)}` : ''),
              () => '',
            )}`,
          );
        caption = undefined;
        this.d.log(`chat: attached ${path.basename(f)} (${bytes.length} bytes)`);
      } catch (err) {
        this.post({ type: 'error', text: `Could not attach ${path.basename(f)}: ${String((err as Error).message)}` });
        // Keep what did not go, so a retry is one click.
        this.pending.push(f);
      }
    }
    this.postPending();
    // Every file failed: the text has not gone anywhere either — send it on its own.
    if (caption) this.d.send({ type: 'chat.send', text: caption });
  }

  private async fileAction(act: 'open' | 'save', id: string): Promise<void> {
    const m = this.messages.find((x) => x.id === id);
    const meta = m?.file_meta;
    if (!meta) return;
    try {
      const res = await this.d.api(meta.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const name = safeLocalName(meta.filename);
      if (act === 'save') {
        const root = this.d.workspaceRoot();
        const dest = await vscode.window.showSaveDialog({
          ...(root ? { defaultUri: vscode.Uri.file(path.join(root, name)) } : {}),
        });
        if (!dest) return;
        await vscode.workspace.fs.writeFile(dest, bytes);
        void vscode.window.showInformationMessage(`Saved ${path.basename(dest.fsPath)}.`);
        return;
      }
      const dir = path.join(this.d.storageRoot(), 'chat-files', id.replace(/[^A-Za-z0-9._-]/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: true });
    } catch (err) {
      this.post({ type: 'error', text: `Could not fetch ${meta.filename}: ${String((err as Error).message)}` });
    }
  }

  // ---- inline review ------------------------------------------------------------

  /**
   * Lay one file's changes into the editor for Accept / Reject per hunk: the
   * agent's copy against its base, placed onto the file the developer has open.
   */
  async reviewFile(rel: string): Promise<void> {
    const proposal = this.d.proposal();
    if (!proposal) return;
    try {
      const real = insideRoot(proposal.repoRoot, rel);
      insideRoot(proposal.dir, rel);
      if (!fs.existsSync(real)) throw new Error('a new file has nothing to review line by line — use Apply or Reject');
      const next = fs.readFileSync(path.join(proposal.dir, rel), 'utf8');
      const base = (await proposalBaseContent(proposal, rel)) ?? '';
      if (next.includes('\0') || base.includes('\0')) throw new Error('binary file — use Apply or Reject');
      await this.d.review.start(
        vscode.Uri.file(real),
        (current) => planPropose(base, next, current),
        (r) => void this.reviewDone(rel, r),
        () =>
          void vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(path.join(proposal.dir, rel)),
            vscode.Uri.file(real),
            `${rel} (agent's version ↔ yours)`,
          ),
      );
    } catch (err) {
      this.post({ type: 'error', text: `Review ${rel}: ${String((err as Error).message)}` });
    }
  }

  private async reviewDone(
    rel: string,
    r: { accepted: number; rejected: number; conflicts: number; applied: number; abandoned: boolean },
  ): Promise<void> {
    const proposal = this.d.proposal();
    // Every hunk decided in the real file: the proposal for it is spent. With
    // hunks set aside (conflicts) it stays, so they can still be taken by hand.
    if (proposal && !r.abandoned && r.conflicts === 0) {
      await rejectProposal(proposal, [rel]).catch((err: unknown) =>
        this.d.log(`review: could not clear ${rel} from the proposal: ${String(err)}`),
      );
    }
    this.tally.files++;
    this.tally.accepted += r.accepted;
    this.tally.rejected += r.rejected;
    recordActivity('review', {
      file: rel,
      accepted: r.accepted,
      rejected: r.rejected,
      conflicts: r.conflicts,
      applied: r.applied,
    });
    this.d.log(
      `review: ${rel} — ${r.accepted} accepted, ${r.rejected} rejected${r.applied ? `, ${r.applied} already in` : ''}${r.conflicts ? `, ${r.conflicts} set aside` : ''}${r.abandoned ? ' (ended early)' : ''}`,
    );
    await this.refreshChanges();
    if (r.abandoned) return;
    // Straight on to the next file: one decision after another, no prompt between files.
    const next = this.nextToReview();
    if (next) {
      void vscode.window.setStatusBarMessage(`Next: ${next}`, 3000);
      void this.reviewFile(next);
    } else this.summarize();
  }

  /** Files reviewed since the last summary. */
  private tally = { files: 0, accepted: 0, rejected: 0 };

  /** Every reviewable file is done: what came of it, and the way on to Git. */
  private summarize(): void {
    const t = this.tally;
    this.tally = { files: 0, accepted: 0, rejected: 0 };
    if (!t.files) return;
    const left = this.proposed.length ? ` ${this.proposed.length} more to apply or reject.` : '';
    void vscode.window
      .showInformationMessage(
        `Reviewed ${t.files} file(s): ${t.accepted} accepted, ${t.rejected} rejected.${left}`,
        'Source Control',
      )
      .then((pick) => pick && vscode.commands.executeCommand('workbench.view.scm'));
  }

  private nextToReview(): string | undefined {
    const root = this.d.proposal()?.repoRoot ?? '';
    return this.reviewable().find((p) => !this.d.review.isReviewing(vscode.Uri.file(path.join(root, p))));
  }

  /** Files that can be reviewed inline right now: modified ones (new and deleted files use Apply / Reject). */
  private reviewable(): string[] {
    return this.d.proposal() ? this.proposed.filter((f) => proposedReviewable(f)).map((f) => f.path) : [];
  }

  /**
   * "Next file" for the review: the changed file after the one in the active
   * editor (wrapping), opened for inline review. Next change stays within a file.
   */
  async reviewNextFile(): Promise<void> {
    await this.refreshChanges();
    const root = this.d.proposal()?.repoRoot;
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const rel = root && active ? path.relative(root, active).split(path.sep).join('/') : null;
    const next = nextReviewFile(this.reviewable(), rel, process.platform === 'win32');
    if (!next) {
      void vscode.window.showInformationMessage('NanoClaw: no changed files to review.');
      return;
    }
    await this.reviewFile(next);
  }

  async reviewNext(): Promise<void> {
    const next = this.nextToReview();
    if (!next) {
      this.post({ type: 'error', text: 'Nothing to review.' });
      return;
    }
    await this.reviewFile(next);
  }

  // ---- code blocks ---------------------------------------------------------------

  private async codeAction(act: string, text: string, lang: string): Promise<void> {
    if (act === 'copy') {
      await vscode.env.clipboard.writeText(text);
      this.post({ type: 'toast', text: 'Copied.' });
      return;
    }
    if (act === 'new') {
      const doc = await vscode.workspace.openTextDocument({ content: text, ...(lang ? { language: lang } : {}) });
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }
    if (act === 'insert') {
      const target = vscode.window.activeTextEditor ?? this.lastEditor;
      if (!target || target.document.isClosed) {
        this.post({ type: 'error', text: 'No open file.' });
        return;
      }
      const ed = await vscode.window.showTextDocument(target.document, {
        viewColumn: target.viewColumn,
        preserveFocus: false,
      });
      await ed.edit((b) => {
        for (const sel of ed.selections) b.replace(sel, text);
      });
    }
  }

  /** The active editor's selection (or whole file when nothing is selected), as a fenced block the developer can prefix. */
  attachSelection(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      this.post({ type: 'error', text: 'No active editor.' });
      return;
    }
    const sel = ed.selection;
    const whole = sel.isEmpty;
    const text = whole ? ed.document.getText() : ed.document.getText(sel);
    if (text.length > 60_000) {
      this.post({ type: 'error', text: 'Selection over 60 KB.' });
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
    const where = whole ? rel : `${rel}:${sel.start.line + 1}-${sel.end.line + 1}`;
    const lang = ed.document.languageId;
    this.post({ type: 'insert', text: `\n${where}\n\`\`\`${lang}\n${text}\n\`\`\`\n` });
    this.reveal();
  }

  reveal(): void {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand('workbench.view.extension.nanoclaw');
  }

  // ---- changes -------------------------------------------------------------

  private proposed: ProposedFile[] = [];

  /** Re-read the proposal: what the agent's copy differs from its base by. */
  async refreshChanges(): Promise<void> {
    const proposal = this.d.proposal();
    if (!proposal) {
      this.proposed = [];
      this.post({ type: 'changes', files: [] });
      this.d.proposedChanged?.(null, []);
      return;
    }
    try {
      this.proposed = await proposalChanges(proposal);
      this.d.proposedChanged?.(proposal.repoRoot, this.proposed);
      // What was already there when the panel first looked is not the agent's news.
      this.seen ??= new Set(this.stamps().keys());
      void this.findConflicts(proposal.repoRoot);
      // A review whose file left the proposal (rejected or applied elsewhere,
      // or the proposal was reset) would otherwise linger in the editor.
      // Windows: VS Code says c:\, the recorded root may say C:\ — compare without case there.
      const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
      const root = norm(proposal.repoRoot + path.sep);
      const pending = new Set(this.proposed.map((f) => norm(path.join(proposal.repoRoot, f.path))));
      for (const uri of this.d.review.reviewing()) {
        const p = norm(uri.fsPath);
        if (p.startsWith(root) && !pending.has(p)) await this.d.review.withdraw(uri);
      }
      this.post({
        type: 'changes',
        conflicts: this.d.conflicts?.under(proposal.repoRoot) ?? [],
        files: this.proposed.map((f) => ({
          path: f.path,
          status: f.status,
          reviewable: proposedReviewable(f),
          risk: f.risk,
        })),
      });
    } catch (err) {
      this.post({ type: 'changes', note: `git failed: ${String((err as Error).message)}`, files: [] });
    }
  }

  /** What each proposed file looked like when the agent last finished a turn (null: not read yet). */
  private seen: Set<string> | null = null;

  /** Each proposed file as status, path and mtime: a changed stamp is new work. */
  private stamps(): Map<string, ProposedFile> {
    const proposal = this.d.proposal();
    const stamp = (f: ProposedFile) => {
      let t = 0;
      try {
        t = proposal ? fs.statSync(path.join(proposal.dir, f.path)).mtimeMs : 0;
      } catch {
        // Deleted: the status alone marks it.
      }
      return `${f.status}:${f.path}:${t}`;
    };
    return new Map(this.proposed.map((f) => [stamp(f), f]));
  }

  /**
   * The agent finished a turn: when its copy holds work that was not there
   * before, say so in the chat with Review / Apply, and — the panel out of
   * sight — as a notification.
   */
  private offerNewWork(): void {
    if (!this.d.proposal()) return;
    const now = this.stamps();
    const fresh = [...now].filter(([k]) => !this.seen?.has(k)).map(([, f]) => f);
    this.seen = new Set(now.keys());
    if (!fresh.length) return;
    const reviewable = fresh.some((f) => proposedReviewable(f));
    this.post({ type: 'newWork', files: fresh.map((f) => f.path), reviewable });
    if (this.view?.visible) return;
    const names = fresh.length === 1 ? fresh[0].path : `${fresh.length} files`;
    const picks = reviewable ? ['Review', 'Source Control'] : ['Source Control'];
    void vscode.window.showInformationMessage(`NanoClaw proposed changes to ${names}.`, ...picks).then((pick) => {
      if (pick === 'Review') void this.reviewNext();
      else if (pick === 'Source Control') void vscode.commands.executeCommand('workbench.view.scm');
    });
  }

  /**
   * Conflict blocks a merged Apply left in files the list does not hold (an
   * Apply from before it existed, or a list lost with the workspace state):
   * found among the developer's changed files, so they are listed too.
   */
  private async findConflicts(root: string): Promise<void> {
    if (!this.d.conflicts) return;
    try {
      const ws = await resolveWorkspace(root);
      if (!ws.repo) return;
      const files = (await changedFiles(root, ws.repo))
        .map((f) => path.join(ws.repo!.workTree, f.path))
        .filter(
          (f) =>
            !this.d.conflicts!.has(f) &&
            fs.statSync(f, { throwIfNoEntry: false })?.isFile() &&
            fs.statSync(f).size < 2_000_000,
        );
      if (files.length) this.d.conflicts.add(files);
    } catch (err) {
      this.d.log(`conflicts: could not look for conflict blocks: ${String((err as Error).message)}`);
    }
  }

  /** A file a merged Apply left conflicts in, opened at the first one. */
  async openConflict(rel: string): Promise<void> {
    const root = this.d.proposal()?.repoRoot;
    if (!root || !this.d.conflicts) return;
    const file = insideRoot(root, rel);
    if (this.d.conflicts.has(file)) await this.d.conflicts.open(file);
  }

  async openDiff(p: string): Promise<void> {
    const proposal = this.d.proposal();
    const f = this.proposed.find((x) => x.path === p);
    if (!proposal || !f) return;
    const inClone = vscode.Uri.file(path.join(proposal.dir, p));
    if (f.status === 'A') {
      await vscode.window.showTextDocument(inClone, { preview: true });
      return;
    }
    const base = this.writeTemp(p, await proposalBaseContent(proposal, p));
    if (f.status === 'D') {
      await vscode.window.showTextDocument(base, { preview: true });
      return;
    }
    await vscode.commands.executeCommand('vscode.diff', base, inClone, `${p} (your commit ↔ proposal)`);
  }

  /** The old side of a diff, as a scratch file named after `p` (empty when there is none). */
  private writeTemp(p: string, content: string | null): vscode.Uri {
    const dir = path.join(this.d.storageRoot(), 'diff');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${randomBytes(6).toString('hex')}-${path.basename(p)}`);
    fs.writeFileSync(tmp, content ?? '');
    return vscode.Uri.file(tmp);
  }

  async proposalAct(what: 'apply' | 'reject', paths?: string[]): Promise<void> {
    const proposal = this.d.proposal();
    if (!proposal) return;
    // A path from the webview is input: act only on files the proposal holds.
    if (paths?.some((p) => !this.proposed.some((f) => f.path === p))) {
      this.post({ type: 'error', text: 'That file is not part of the proposal.' });
      return;
    }
    const which = paths ? paths.join(', ') : `all ${this.proposed.length} file(s)`;
    if (what === 'reject') {
      const ok = await vscode.window.showWarningMessage(`Reject the proposal for ${which}?`, { modal: true }, 'Reject');
      if (ok !== 'Reject') return;
    }
    // A change that could run something on this machine (editor config, a
    // hook, attributes, a link, an exec bit) is never part of "apply all";
    // on its own it is applied after a yes that names why.
    let held: ProposedFile[] = [];
    if (what === 'apply') {
      if (paths) {
        for (const f of this.proposed.filter((x) => paths!.includes(x.path) && x.risk)) {
          const ok = await vscode.window.showWarningMessage(`${f.path}: ${f.risk}. Apply?`, { modal: true }, 'Apply');
          if (ok !== 'Apply') return;
        }
      } else {
        held = this.proposed.filter((f) => f.risk);
        paths = this.proposed.filter((f) => !f.risk).map((f) => f.path);
        if (!paths.length) {
          this.post({ type: 'error', text: 'Apply these one by one.' });
          return;
        }
      }
    }
    // A file open for inline review holds the proposed lines in the editor;
    // take them back out first, or they would stay behind after the panel
    // decided the file (and an apply would land them twice).
    for (const rel of paths ?? this.proposed.map((f) => f.path)) {
      const uri = vscode.Uri.file(path.join(proposal.repoRoot, rel));
      if (this.d.review.isReviewing(uri)) await this.d.review.withdraw(uri);
    }
    try {
      if (what === 'apply') {
        const { applied, conflicted } = await applyProposal(proposal, paths);
        // Applied files leave the proposal: the clone is reset for them so the
        // next refresh shows only what is still pending. A merged file's
        // conflict blocks carry what is left to decide, in the file itself.
        if (applied.length) await rejectProposal(proposal, applied);
        for (const file of applied)
          recordActivity('proposal.apply', { file, repo: proposal.repoRoot, conflict: conflicted.includes(file) });
        this.d.log(
          `proposal: applied ${applied.length} file(s) to ${proposal.repoRoot}: ${applied.join(', ')}${conflicted.length ? ` (conflicts: ${conflicted.join(', ')})` : ''}`,
        );
        this.d.conflicts?.add(conflicted.map((rel) => path.join(proposal.repoRoot, rel)));
        const skipped = held.length ? ` Skipped ${held.length}: apply one by one.` : '';
        if (conflicted.length) {
          await this.openConflict(conflicted[0]);
          void vscode.window
            .showWarningMessage(
              `Applied ${applied.length}; conflicts to resolve in ${conflicted.join(', ')}, where you and the agent changed the same lines.${skipped}`,
              'Next conflict',
            )
            .then((pick) => pick && vscode.commands.executeCommand('nanoclaw.review.next'));
        } else {
          void vscode.window
            .showInformationMessage(`Applied ${applied.length}.${skipped}`, 'Source Control')
            .then((pick) => pick && vscode.commands.executeCommand('workbench.view.scm'));
        }
      } else {
        await rejectProposal(proposal, paths);
        for (const file of paths ?? this.proposed.map((f) => f.path))
          recordActivity('proposal.reject', { file, repo: proposal.repoRoot });
      }
    } catch (err) {
      const msg = String((err as Error).message);
      this.post({
        type: 'error',
        text:
          msg.includes('conflict') || msg.includes('patch does not apply')
            ? `Could not apply cleanly (your tree changed the same lines): ${msg.slice(0, 200)}`
            : msg.slice(0, 300),
      });
    }
    await this.refreshChanges();
  }

  // ---- rendering -------------------------------------------------------------

  private repaint(): void {
    this.post({
      type: 'room',
      name: this.room?.name ?? '',
      status: this.status,
      html: this.messages.map((m) => this.renderOne(m)).join(''),
    });
  }

  private post(m: Record<string, unknown>): void {
    void this.view?.webview.postMessage(m);
  }

  private renderOne(m: ChatMessage): string {
    const who = escapeHtml(m.sender || (m.sender_type === 'agent' ? 'agent' : 'you'));
    const cls = m.sender_type === 'agent' ? 'agent' : m.sender_type === 'user' ? 'user' : 'system';
    const t = new Date(m.created_at);
    const time = isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // The editor note is for the agent; show it small rather than as prose.
    const { text, note } = splitEditorNote(m.content);
    const small = note ? `<small class="note">editor: ${escapeHtml(note)}</small>` : '';
    const body =
      m.message_type === 'file'
        ? `${text ? renderMarkdown(text) : ''}${small}${fileCard(m.id, m.file_meta)}`
        : m.message_type && m.message_type !== 'text'
          ? `<p><em>[${escapeHtml(m.message_type)}]</em> ${escapeHtml(m.content)}</p>`
          : `${renderMarkdown(text)}${small}`;
    return `<div class="msg ${cls}" data-id="${escapeHtml(m.id)}"><div class="meta"><span class="who">${who}</span><span class="time">${time}</span></div><div class="body">${body}</div></div>`;
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); display: flex; flex-direction: column; height: 100vh; }
  #status { padding: 4px 10px; font-size: 11px; opacity: .75; border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); display:flex; justify-content:space-between; align-items:center; }
  #log { flex: 1; overflow-y: auto; padding: 6px 8px; }
  .msg { margin: 6px 0; padding: 6px 8px; border-radius: 6px; background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-textLink-foreground); }
  .msg.user { border-left-color: var(--vscode-charts-green, #5a5); }
  .msg.system { opacity: .8; border-left-color: var(--vscode-descriptionForeground); }
  .meta { display: flex; justify-content: space-between; font-size: 11px; opacity: .7; margin-bottom: 2px; }
  .body p { margin: 4px 0; white-space: pre-wrap; word-break: break-word; }
  .body pre { margin: 6px 0; padding: 6px 8px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
  .body code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .body h3,.body h4,.body h5,.body h6 { margin: 8px 0 2px; font-size: 13px; }
  .body ul,.body ol { margin: 4px 0; padding-left: 20px; }
  .body a { color: var(--vscode-textLink-foreground); }
  .body .note { display:block; opacity:.55; font-size:11px; margin-top:4px; }
  #changes { border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); max-height: 40%; display:flex; flex-direction:column; }
  #changes header { display:flex; justify-content:space-between; align-items:center; padding: 4px 10px; font-size: 11px; text-transform: uppercase; letter-spacing:.04em; opacity:.8; cursor:pointer; }
  #changes header .count { opacity:.7; text-transform:none; letter-spacing:0; }
  #changesBody { overflow-y:auto; padding: 0 6px 6px; }
  #changesBody.hidden { display:none; }
  .file { display:flex; align-items:center; gap:6px; padding: 3px 4px; border-radius:4px; font-size:12px; }
  .file:hover { background: var(--vscode-list-hoverBackground); }
  .file .st { width: 16px; text-align:center; font-family: var(--vscode-editor-font-family); opacity:.8; }
  .file .path { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
  .file .badge { font-size:10px; padding:0 5px; border-radius:8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .file .badge.risk { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-foreground); }
  .file button { padding: 1px 6px; font-size: 11px; }
  .changesNote { opacity:.6; font-size:11px; padding: 2px 4px 6px; }
  #composer { border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 60px; max-height: 240px; resize: vertical; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 6px; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
  .hint { flex: 1; font-size: 11px; opacity: .6; }
  button { font: inherit; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--vscode-foreground); }
  button:hover { filter: brightness(1.1); }
  #error { color: var(--vscode-errorForeground); font-size: 12px; padding: 0 10px; min-height: 1em; }
  #empty { opacity: .6; font-size: 12px; padding: 12px; }
  #working { display:none; align-items:center; gap:8px; padding: 4px 10px; font-size: 12px; opacity: .85; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); }
  #working.on { display:flex; }
  #working.stalled { color: var(--vscode-editorWarning-foreground); }
  #working .dot { width:8px; height:8px; border-radius:50%; background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); animation: pulse 1.2s ease-in-out infinite; flex: none; }
  #working.stalled .dot { animation:none; background: var(--vscode-editorWarning-foreground); }
  #workingText { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  @keyframes pulse { 0%,100% { opacity:.25 } 50% { opacity:1 } }
  .body pre { position: relative; }
  .codebar { position:absolute; top:3px; right:3px; display:none; gap:3px; padding:2px; border-radius:4px; background: var(--vscode-editor-background); box-shadow: 0 0 0 1px var(--vscode-widget-border, transparent); }
  .body pre:hover .codebar, .codebar:focus-within { display:flex; }
  .codebar button { padding: 1px 6px; font-size: 11px; }
  .filecard { display:flex; align-items:center; gap:6px; margin: 4px 0; padding: 4px 6px; border-radius:4px; background: var(--vscode-textCodeBlock-background); font-size:12px; }
  .filecard .fname { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .filecard .fsize { opacity:.6; font-size:11px; }
  .filecard button { padding: 1px 6px; font-size: 11px; }
  #chips { display:flex; flex-wrap:wrap; gap:4px; }
  #chips:empty { display:none; }
  .chip { display:flex; align-items:center; gap:4px; font-size:11px; padding: 1px 4px 1px 8px; border-radius:10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); max-width: 100%; }
  .chip span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip button { padding: 0 5px; font-size: 11px; background: transparent; color: inherit; }
  #toast { position: fixed; bottom: 8px; left: 50%; transform: translateX(-50%); font-size: 11px; padding: 2px 8px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: 0; transition: opacity .2s; pointer-events:none; }
  #toast.on { opacity: 1; }
</style></head><body>
<div id="status"><span id="statusText">Connecting…</span><button class="secondary" id="reopen" title="Reload the room">↻</button></div>
<div id="log"><div id="empty">No messages.</div></div>
<section id="changes">
  <header id="changesHeader"><span><span id="changesTitle">Proposal</span> <span class="count" id="changesCount"></span></span><span><button id="reviewAll" title="Review the agent's changes in the editor, hunk by hunk" style="display:none">Review</button> <button class="secondary" id="applyAll" title="Apply every proposed file to your working tree" style="display:none">Apply all</button> <button class="danger" id="rejectAll" title="Discard the whole proposal" style="display:none">Reject all</button> <button class="secondary" id="refreshChanges" title="Re-read the proposal">↻</button></span></header>
  <div id="changesBody"><div class="changesNote" id="changesNote">No proposal.</div></div>
</section>
<div id="working" role="status" aria-live="polite"><span class="dot"></span><span id="workingText">Working…</span></div>
<div id="error"></div>
<div id="composer">
  <div id="chips"></div>
  <textarea id="input" placeholder="Message"></textarea>
  <div class="row"><span class="hint" id="hint"></span><button class="secondary" id="attachFile" title="Attach files to send with the next message">+ File</button><button class="secondary" id="attach" title="Insert the current selection (or whole file) as a code block">+ Selection</button><button id="send">Send</button></div>
</div>
<div id="toast"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log'), input = document.getElementById('input'), err = document.getElementById('error');
  const statusText = document.getElementById('statusText'), empty = document.getElementById('empty');
  const changesBody = document.getElementById('changesBody'), changesNote = document.getElementById('changesNote'), changesCount = document.getElementById('changesCount');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  const working = document.getElementById('working'), workingText = document.getElementById('workingText');
  const chips = document.getElementById('chips'), toast = document.getElementById('toast');
  let pendingCount = 0;
  function send() { const t = input.value.trim(); if (!t && !pendingCount) return; vscode.postMessage({ type: 'send', text: t || ' ' }); input.value = ''; err.textContent = ''; }
  document.getElementById('attachFile').onclick = () => vscode.postMessage({ type: 'attachFile' });
  // Code blocks: a small toolbar on hover. The text is read back from the DOM,
  // which holds exactly what was rendered (escaped on the way in).
  function decorate(root) {
    root.querySelectorAll('.body pre').forEach((pre) => {
      if (pre.querySelector('.codebar')) return;
      const code = pre.querySelector('code');
      const lang = ((code && code.className) || '').replace(/^lang-/, '');
      const bar = document.createElement('div'); bar.className = 'codebar';
      for (const [act, label, title] of [['copy', 'Copy', 'Copy to the clipboard'], ['insert', 'Insert', 'Insert at the cursor (replaces the selection)'], ['new', 'New file', 'Open in a new untitled editor']]) {
        const b = document.createElement('button'); b.className = 'secondary'; b.textContent = label; b.title = title;
        b.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'code', act, lang, text: code ? code.textContent : pre.textContent }); };
        bar.appendChild(b);
      }
      pre.appendChild(bar);
    });
    root.querySelectorAll('[data-file]').forEach((b) => { if (!b.onclick) b.onclick = () => vscode.postMessage({ type: 'file.' + b.dataset.file, id: b.dataset.id }); });
  }
  document.getElementById('send').onclick = send;
  document.getElementById('attach').onclick = () => vscode.postMessage({ type: 'attachSelection' });
  document.getElementById('reopen').onclick = () => vscode.postMessage({ type: 'reopen' });
  document.getElementById('refreshChanges').onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'changes.refresh' }); };
  const applyAll = document.getElementById('applyAll'), rejectAll = document.getElementById('rejectAll'), reviewAll = document.getElementById('reviewAll');
  reviewAll.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'review.all' }); };
  applyAll.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'proposal.apply' }); };
  rejectAll.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: 'proposal.reject' }); };
  document.getElementById('changesHeader').onclick = () => changesBody.classList.toggle('hidden');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  function renderChanges(m) {
    const files = m.files || [];
    const conflicts = m.conflicts || [];
    applyAll.style.display = files.length ? '' : 'none';
    rejectAll.style.display = files.length ? '' : 'none';
    reviewAll.style.display = files.some((f) => f.reviewable) ? '' : 'none';
    const conflictRows = conflicts.map((c) =>
      '<div class="file"><span class="st" title="conflicts to resolve">⚠</span>' +
      '<span class="path conflict" title="Open at the next conflict" data-path="' + esc(c.path) + '">' + esc(c.path) + '</span>' +
      '<span class="badge risk">' + c.blocks + ' conflict' + (c.blocks === 1 ? '' : 's') + '</span>' +
      '<button data-act="conflict.open" data-path="' + esc(c.path) + '" title="Go to the next conflict">Next</button></div>').join('');
    changesCount.textContent = files.length + conflicts.length ? '(' + (files.length + conflicts.length) + ')' : '';
    if (!files.length) {
      changesBody.innerHTML = conflictRows || '<div class="changesNote">' + esc(m.note || 'No proposal.') + '</div>';
      bindChanges();
      return;
    }
    const acts = [['changes.diff', 'secondary', 'Diff', 'Diff: your commit vs the proposal'], ['proposal.apply', 'secondary', 'Apply', 'Apply the whole file to your working tree'], ['proposal.reject', 'danger', 'Reject', 'Discard this proposed change']];
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    changesBody.innerHTML = conflictRows + (m.note ? '<div class="changesNote">' + esc(m.note) + '</div>' : '') + sorted.map((f) =>
      '<div class="file"><span class="st" title="proposed change">' + esc(f.status) + '</span>' +
      '<span class="path" title="Open diff" data-path="' + esc(f.path) + '">' + esc(f.path) + '</span>' +
      (f.risk ? '<span class="badge risk" title="Not in Apply all">' + esc(f.risk) + '</span>' : '') +
      (f.reviewable ? '<button data-act="review" data-path="' + esc(f.path) + '" title="Accept or reject each change in the editor">Review</button>' : '') +
      acts.map(([act, cls, label, title]) => '<button class="' + cls + '" data-act="' + act + '" data-path="' + esc(f.path) + '" title="' + title + '">' + label + '</button>').join('') + '</div>').join('');
    bindChanges();
  }
  function bindChanges() {
    changesBody.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => vscode.postMessage({ type: b.dataset.act, path: b.dataset.path }); });
    changesBody.querySelectorAll('.path').forEach((p) => { p.onclick = () => vscode.postMessage({ type: p.classList.contains('conflict') ? 'conflict.open' : 'changes.diff', path: p.dataset.path }); });
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'room') { statusText.textContent = m.status || ''; log.innerHTML = m.html || ''; if (!m.html) log.appendChild(empty); else empty.remove(); decorate(log); scroll(); }
    else if (m.type === 'message') { empty.remove(); const keep = atBottom(); log.insertAdjacentHTML('beforeend', m.html); decorate(log); if (keep) scroll(); }
    else if (m.type === 'working') { working.classList.toggle('on', !!m.text); working.classList.toggle('stalled', !!m.stalled); if (m.text) workingText.textContent = m.text; }
    else if (m.type === 'pending') { pendingCount = m.files.length; chips.innerHTML = m.files.map((f) => '<span class="chip" title="' + esc(f.path) + '"><span>📎 ' + esc(f.label) + '</span><button data-path="' + esc(f.path) + '" title="Remove">×</button></span>').join(''); chips.querySelectorAll('button').forEach((b) => { b.onclick = () => vscode.postMessage({ type: 'unattach', path: b.dataset.path }); }); }
    else if (m.type === 'toast') { toast.textContent = m.text; toast.classList.add('on'); setTimeout(() => toast.classList.remove('on'), 1200); }
    else if (m.type === 'status') { statusText.textContent = m.text; }
    else if (m.type === 'error') { err.textContent = m.text; }
    else if (m.type === 'insert') { input.value = (input.value ? input.value.replace(/\\s*$/, '') + '\\n' : '') + m.text; input.focus(); input.setSelectionRange(0, 0); }
    else if (m.type === 'changes') { renderChanges(m); }
    else if (m.type === 'newWork') {
      empty.remove(); const keep = atBottom();
      const card = document.createElement('div'); card.className = 'msg system newwork';
      card.innerHTML = '<div class="body"><p>Proposed: ' + m.files.map(esc).join(', ') + '</p></div>';
      const row = document.createElement('div'); row.className = 'row';
      for (const [type, cls, label] of [m.reviewable ? ['review.all', '', 'Review'] : null, ['proposal.apply', 'secondary', 'Apply all']].filter(Boolean)) {
        const b = document.createElement('button'); if (cls) b.className = cls; b.textContent = label;
        b.onclick = () => vscode.postMessage({ type }); row.appendChild(b);
      }
      card.appendChild(row); log.appendChild(card); if (keep) scroll();
    }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }
}

// A marked change (a link above all: its "content" is whatever it points at) is applied whole, after a yes.
export const proposedReviewable = (f: ProposedFile): boolean => f.status === 'M' && !f.risk;

/** `root/rel`, refused when `rel` climbs out of `root` — the list is ours today, but a path is still input. */
function insideRoot(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep))
    throw new Error(`refusing a path outside the repository: ${rel}`);
  return full;
}
