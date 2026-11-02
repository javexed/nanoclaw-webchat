/**
 * What an agent is told around an approval-gated `ncl` command, registered on
 * the CLI seam (cli/registry.ts `registerApprovalWords`):
 *
 *   - while it waits: WHO can approve it and WHERE ("card posted in this room;
 *     Alice (owner) can approve it here" versus "sent to … in Admin →
 *     Approvals"), so an agent talking to an approver stops telling them that
 *     "an owner" has to approve it;
 *   - once it ran: one readable line per command where a summarizer exists,
 *     the raw result under "Details:", always redacted (signed URLs, long
 *     base64, token-looking strings) and capped. A known failure says its
 *     cause and fix instead of a wall of build log.
 *
 * The same outcome is kept for the room's card (takeApprovedOutcome), so the
 * people who approved see the result next to their click.
 */
import { localizeIsoTimestamps } from '../../cli/format.js';
import type { CallerContext, RequestFrame, ResponseFrame } from '../../cli/frame.js';
import { registerApprovalWords } from '../../cli/registry.js';
import { redactSensitiveData } from '../../channels/webchat/redact.js';
import { isOwner } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';
import { pickApprover } from './primitive.js';

// ── People ───────────────────────────────────────────────────────────────────

/** "alice.smith@example.com" → "Alice Smith". A plain name passes through. */
export function humanName(raw: string): string {
  const base = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
  if (!base) return raw;
  if (/\s/.test(base) || /[A-Z]/.test(base)) return base;
  return base
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/** A user's readable name: their display name, else the handle part of the id. */
export async function personName(userId: string): Promise<string> {
  const u = await getUser(userId).catch(() => undefined);
  const raw = u?.display_name || userId.split(':').pop() || userId;
  return humanName(raw);
}

/** "Alice Smith (owner)". */
export async function approverLabel(userId: string): Promise<string> {
  return `${await personName(userId)} (${(await isOwner(userId)) ? 'owner' : 'admin'})`;
}

/** "A", "A or B", "A, B or C", "A, B, C or 2 others". */
export function listNames(names: string[], max = 3): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} or ${rest} other${rest === 1 ? '' : 's'}`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} or ${shown[shown.length - 1]}`;
}

// ── Where the card goes ──────────────────────────────────────────────────────

/**
 * A surface that shows the card in the conversation itself (webchat rooms).
 * Given the conversation and the eligible approvers, it returns the approvers
 * who can act on the card there, or null when it does not show cards in that
 * conversation.
 */
export type ApprovalVenue = (messagingGroupId: string, approvers: string[]) => Promise<string[] | null>;

let venue: ApprovalVenue | null = null;

export function registerApprovalVenue(fn: ApprovalVenue | null): void {
  venue = fn;
}

/** Approvers who can act on the card in this conversation; null when it is not shown there. */
export async function approversInConversation(messagingGroupId: string, approvers: string[]): Promise<string[] | null> {
  if (!venue) return null;
  try {
    return await venue(messagingGroupId, approvers);
  } catch {
    return null;
  }
}

/** What the agent hears while its command waits for a card. */
export async function pendingWords(ctx: CallerContext): Promise<string | undefined> {
  if (ctx.caller !== 'agent') return undefined;
  const approvers = await pickApprover(ctx.agentGroupId);
  if (approvers.length === 0) return undefined;
  const here = await approversInConversation(ctx.messagingGroupId, approvers);
  if (here && here.length > 0) {
    const names = listNames(await Promise.all(here.map(approverLabel)));
    return (
      `Approval card posted in this conversation. ${names} can approve it right here. ` +
      `If you are talking with ${here.length === 1 ? 'them' : 'one of them'}, ask them to approve the card above. ` +
      `You will be told the result.`
    );
  }
  const names = listNames(await Promise.all(approvers.map(approverLabel)));
  return (
    `Approval request sent to ${names} in Admin → Approvals; nobody who can approve it is in this conversation. ` +
    `You will be told the result.`
  );
}

// ── Redaction ────────────────────────────────────────────────────────────────

/** Query parameters that carry a signature or a credential. */
const SIGNED_PARAM =
  /([?&])(X-Amz-[A-Za-z-]+|Signature|Expires|Key-Pair-Id|Policy|sig|se|sp|sv|sr|skoid|token|access_token|AWSAccessKeyId)=[^\s"'&<>)\]\\]*/gi;
/** A path or URL followed by a query string: the whole query goes. */
const PATH_QUERY = /(\b[\w.-]*\/[^\s"'?<>\\]*)\?[^\s"'<>)\]\\]*=[^\s"'<>)\]\\]*/g;
/** A long run that looks like base64 or a token. Hex digests are kept. */
const LONG_TOKEN = /[A-Za-z0-9+_~-]{40,}={0,2}/g;

/**
 * Strip what must never reach an agent or a chat: signed URLs and their query
 * strings, long base64 runs, and token-looking strings (redact.ts patterns).
 */
export function redactResultText(text: string): string {
  let out = text.replace(PATH_QUERY, '$1?[redacted]').replace(SIGNED_PARAM, '$1$2=[redacted]');
  out = out.replace(LONG_TOKEN, (m) => {
    if (/^[0-9a-f]+$/i.test(m)) return m; // a digest: useful, not secret
    if (/^[a-z-]+$/.test(m) || /^[A-Z_]+$/.test(m)) return m; // a long word or constant
    if (!/\d/.test(m) || !/[a-z]/.test(m) || !/[A-Z]/.test(m)) return m;
    return '[redacted]';
  });
  return redactSensitiveData(out);
}

export const DETAILS_MAX = 1200;

/** Cap long text, keeping the start and the end (a build log's cause is at the end). */
export function capText(text: string, max = DETAILS_MAX): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

// ── Known failures ───────────────────────────────────────────────────────────

interface FailureClass {
  test: (raw: string) => boolean;
  /** Cause, then what to do about it. */
  words: string;
}

const FAILURES: FailureClass[] = [
  {
    test: (r) =>
      /(docker\.io|docker\.com|registry-1\.docker)/i.test(r) &&
      /(forbidden|403|failed to resolve source metadata|failed to do request|i\/o timeout|connection refused|no such host|denied)/i.test(
        r,
      ),
    words:
      "The build couldn't reach Docker Hub to fetch its base image. An admin can allow it for this agent: Agent → Apps → Allow Docker Hub for builds.",
  },
  {
    test: (r) => /workloads are off/i.test(r),
    words: 'Workloads are off on this host. An operator turns them on.',
  },
  {
    test: (r) => /quota/i.test(r) && /(exceed|over|more than|not enough|left)/i.test(r),
    words: "It needs more than this agent's quota allows. Make the stack smaller, or ask an admin to raise the quota.",
  },
  {
    test: (r) => /changed since the approval|no approval on record|was never approved/i.test(r),
    words: 'It changed after the card was approved. Run `ncl workloads check`, then ask again.',
  },
  {
    test: (r) => /(manifest unknown|pull access denied|repository does not exist|not found: manifest)/i.test(r),
    words: "The image couldn't be found. Check its name and tag.",
  },
  {
    test: (r) => /no space left on device/i.test(r),
    words: 'The host ran out of disk space. An admin needs to free some.',
  },
  {
    test: (r) => /builds are not available on this host/i.test(r),
    words: "Builds aren't available on this host. Use a published image instead of a Dockerfile.",
  },
];

/** Cause and fix for a known failure; otherwise the first line of the (redacted) error. */
export function explainFailure(raw: string): string {
  for (const f of FAILURES) if (f.test(raw)) return f.words;
  const first =
    redactResultText(raw)
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const line = first.length > 200 ? `${first.slice(0, 199)}…` : first;
  return line ? `${line.replace(/[.:]$/, '')}.` : 'No reason was given.';
}

// ── Summaries ────────────────────────────────────────────────────────────────

/**
 * One command's outcome in words. `failed` carries the raw error when the
 * command ran but what it did failed (a deploy whose build broke).
 */
export interface Summary {
  text: string;
  failed?: string;
}

export type Summarizer = (data: unknown, args: Record<string, unknown>) => Summary | undefined;

const summarizers = new Map<string, Summarizer>();

/** A module names the outcome of one of its approval-gated commands. */
export function registerApprovedSummary(command: string, fn: Summarizer): void {
  summarizers.set(command, fn);
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const q = (v: unknown): string => `"${String(v ?? '')}"`;

function addresses(view: Record<string, unknown>): string {
  const a = rec(view.services_private);
  const parts = Object.entries(a).map(([svc, ip]) => `${svc} at ${String(ip)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** A workload view (`ncl workloads up/redeploy/start/restore`) after `verb`. */
function workloadSummary(verb: string): Summarizer {
  return (data) => {
    const v = rec(data);
    if (!v.name) return undefined;
    if (v.state === 'failed') {
      return { text: `${verb} ${q(v.name)}, but it failed`, failed: String(v.error ?? 'no reason given') };
    }
    const open = typeof v.open === 'string' && v.open ? ` ${v.open}` : '';
    return { text: `${verb} ${q(v.name)}: ${String(v.state ?? 'done')}${addresses(v)}.${open}` };
  };
}

registerApprovedSummary('workloads-up', workloadSummary('Deployed'));
registerApprovedSummary('workloads-redeploy', workloadSummary('Redeployed'));
registerApprovedSummary('workloads-start', workloadSummary('Started'));
registerApprovedSummary('workloads-restore', workloadSummary('Restored'));
registerApprovedSummary('workloads-stop', (d) =>
  rec(d).name ? { text: `Stopped ${q(rec(d).name)}; its data is kept.` } : undefined,
);
registerApprovedSummary('workloads-down', (d) =>
  rec(d).name ? { text: `Removed the containers of ${q(rec(d).name)}; its data volumes are kept.` } : undefined,
);
registerApprovedSummary('workloads-delete', (d, args) => {
  const name = rec(d).name ?? args.name;
  return name ? { text: `Deleted ${q(name)} and its data.` } : undefined;
});
registerApprovedSummary('workloads-expose', (d) => {
  const r = rec(d);
  if (!r.app) return undefined;
  if (typeof r.url === 'string' && r.url)
    return { text: `Published ${q(r.app)} at ${r.url} (who can open it: ${String(r.who ?? 'only-me')}).` };
  return { text: `Published ${q(r.app)}; it isn't reachable yet (${String(r.state ?? 'starting')}).` };
});
registerApprovedSummary('workloads-unexpose', (d, args) => {
  const app = rec(d).app ?? args.app;
  return app ? { text: `Stopped publishing ${q(app)}; the workload keeps running.` } : undefined;
});

/** Flags the agent set, without the ones dispatch fills in. */
const SCOPE_ARGS = new Set(['id', 'group', 'agent_group_id', 'help', 'approved', 'ticket']);
const changedFlags = (args: Record<string, unknown>): string[] => Object.keys(args).filter((k) => !SCOPE_ARGS.has(k));

registerApprovedSummary('groups-config-update', (d, args) => {
  const flags = changedFlags(args);
  const what = flags.length ? ` (${flags.map((f) => f.replace(/_/g, ' ')).join(', ')})` : '';
  return { text: `Updated this agent's settings${what}${rec(d).restarted ? '; it restarted to apply them' : ''}.` };
});
registerApprovedSummary('groups-config-add-mcp-server', (d) =>
  rec(d).added ? { text: `Added the MCP server ${q(rec(d).added)}.` } : undefined,
);
registerApprovedSummary('groups-config-remove-mcp-server', (d) =>
  rec(d).removed ? { text: `Removed the MCP server ${q(rec(d).removed)}.` } : undefined,
);
registerApprovedSummary('groups-restart', () => ({ text: 'Restarted this agent.' }));
registerApprovedSummary('tasks-create', (d) => {
  const t = rec(localizeIsoTimestamps(d));
  const id = t.series_id ?? t.id ?? t.row_id;
  if (!id) return undefined;
  const when = t.process_after ? `, first run ${String(t.process_after)}` : '';
  const repeat = t.recurrence ? ` (repeats: ${String(t.recurrence)})` : '';
  return { text: `Scheduled the task ${q(id)}${when}${repeat}.` };
});

// ── The outcome ──────────────────────────────────────────────────────────────

/** What the requesting agent and the room's card both show. */
export interface ApprovedOutcome {
  /** One line for the agent: the summary, or the failure's cause and fix. */
  line: string;
  /** The same without "Approved…": the room's card already says who approved it. */
  outcome: string;
  /** The raw result or error, redacted and capped; '' when there is nothing more. */
  details: string;
  failed: boolean;
  /** A clean summary says it all to the agent; the card still offers the details. */
  summarized?: boolean;
}

function rawText(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  const localized = localizeIsoTimestamps(v);
  return typeof localized === 'string' ? localized : JSON.stringify(localized, null, 2);
}

/** Word one approved command's outcome. Pure apart from the summarizer registry. */
export function describeApprovedOutcome(frame: RequestFrame, response: ResponseFrame): ApprovedOutcome {
  const cmd = `\`ncl ${frame.command}\``;
  if (!response.ok) {
    const raw = response.error.message;
    return {
      line: `Approved, but ${cmd} failed: ${explainFailure(raw)}`,
      outcome: `${cmd} failed: ${explainFailure(raw)}`,
      details: capText(redactResultText(raw)),
      failed: true,
    };
  }
  let summary: Summary | undefined;
  try {
    summary = summarizers.get(frame.command)?.(response.data, frame.args ?? {});
  } catch {
    summary = undefined;
  }
  const details = capText(redactResultText(rawText(response.data)));
  if (summary?.failed !== undefined) {
    // The error itself reads better than the escaped JSON it sits in.
    const outcome = `${summary.text}: ${explainFailure(summary.failed)}`;
    return { line: `Approved. ${outcome}`, outcome, details: capText(redactResultText(summary.failed)), failed: true };
  }
  if (summary) {
    return {
      line: `Approved and done. ${summary.text}`,
      outcome: summary.text,
      details,
      failed: false,
      summarized: true,
    };
  }
  return { line: `Approved and done (${cmd}).`, outcome: 'Done.', details, failed: false };
}

/** The agent's text: the line, then the details unless a summary said it all. */
export function outcomeText(o: ApprovedOutcome): string {
  return o.details && !o.summarized ? `${o.line}\n\nDetails:\n${o.details}` : o.line;
}

// Outcomes the room's card picks up when the resolution reaches it, which is
// right after the handler returns. Bounded: an outcome nobody takes is dropped.
const OUTCOME_KEEP = 200;
const outcomes = new Map<string, ApprovedOutcome>();

function keepOutcome(approvalId: string, o: ApprovedOutcome): void {
  outcomes.set(approvalId, o);
  while (outcomes.size > OUTCOME_KEEP) outcomes.delete(outcomes.keys().next().value as string);
}

/** The outcome of an approval that just ran, once. */
export function takeApprovedOutcome(approvalId: string): ApprovedOutcome | undefined {
  const o = outcomes.get(approvalId);
  outcomes.delete(approvalId);
  return o;
}

registerApprovalWords({
  pending: pendingWords,
  approved: ({ approvalId, frame, response }) => {
    const o = describeApprovedOutcome(frame, response);
    keepOutcome(approvalId, o);
    return outcomeText(o);
  },
});
