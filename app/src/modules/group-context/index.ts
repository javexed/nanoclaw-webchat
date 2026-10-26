/**
 * `ncl groups context` — what goes into an agent group's context, by source.
 *
 * An agent's instructions arrive from many places: the composed project
 * document (persona, runtime contract, module and skill prose, MCP server
 * notes), the runner's system-prompt addendum (identity, destinations,
 * prompt-section contributors), the memory section, and skills loaded on
 * demand. When two of them disagree the agent sees a contradiction nobody
 * wrote in one place; this lists every source in order, with its size and
 * whether it made it in, so the disagreement can be found by reading.
 *
 * Read-only, and registered on the `groups` resource so group-scoped agents
 * reach it under the same rules as `groups get`: their own group only.
 */
import '../../cli/resources/groups.js';
import { getResource, validateArgs, type CustomOperation } from '../../cli/crud.js';
import { normalizeArgs } from '../../cli/args.js';
import { register } from '../../cli/registry.js';
import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { formatLocalTime } from '../../timezone.js';
import { projectDocManifest, type ContextSource, type SourceLayer, type SourceStatus } from './project-doc.js';
import { runtimeContext } from './runtime.js';

/** Characters / 4: no tokenizer ships with the host, and the point is proportion, not billing. */
export const TOKEN_ESTIMATE = 'chars/4';
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ContextRow {
  index: number;
  name: string;
  layer: SourceLayer;
  origin: string;
  status: SourceStatus;
  reason?: string;
  bytes: number;
  tokens: number;
}

export interface GroupContextReport {
  group: { id: string; name: string; folder: string };
  document?: { fileName: string; maxBytes?: number; bytes: number; tokens: number };
  session?: { id: string; recordedAt?: string; provider?: string };
  tokenEstimate: typeof TOKEN_ESTIMATE;
  sources: ContextRow[];
  /** Sources always in context (project document, addendum, memory) that made it in. */
  total: { bytes: number; tokens: number };
}

const ALWAYS_LOADED: ReadonlySet<SourceLayer> = new Set(['project-doc', 'system-prompt', 'memory']);
const COUNTED: ReadonlySet<SourceStatus> = new Set(['included', 'truncated']);

export async function groupContextSources(
  groupId: string,
  sessionId?: string,
): Promise<{ report: GroupContextReport; sources: ContextSource[] }> {
  const group = await getAgentGroup(groupId);
  if (!group) throw new Error(`agent group not found: ${groupId}`);
  const doc = await projectDocManifest(group);
  const runtime = await runtimeContext(group, doc.provider, sessionId);
  const sources = [...doc.sources, ...runtime.sources];

  const rows = sources.map((s, i) => ({
    index: i + 1,
    name: s.name,
    layer: s.layer,
    origin: s.origin,
    status: s.status,
    ...(s.reason ? { reason: s.reason } : {}),
    bytes: Buffer.byteLength(s.text, 'utf-8'),
    tokens: estimateTokens(s.text),
  }));
  const counted = rows.filter((r) => ALWAYS_LOADED.has(r.layer) && COUNTED.has(r.status));
  const report: GroupContextReport = {
    group: { id: group.id, name: group.name, folder: group.folder },
    ...(doc.fileName
      ? {
          document: {
            fileName: doc.fileName,
            ...(doc.maxBytes === undefined ? {} : { maxBytes: doc.maxBytes }),
            bytes: Buffer.byteLength(doc.content, 'utf-8'),
            tokens: estimateTokens(doc.content),
          },
        }
      : {}),
    ...(runtime.sessionId
      ? { session: { id: runtime.sessionId, recordedAt: runtime.recordedAt, provider: runtime.provider } }
      : {}),
    tokenEstimate: TOKEN_ESTIMATE,
    sources: rows,
    total: {
      bytes: counted.reduce((n, r) => n + r.bytes, 0),
      tokens: counted.reduce((n, r) => n + r.tokens, 0),
    },
  };
  return { report, sources };
}

/** `--show` takes a row number or a source name (case-insensitive; a unique prefix will do). */
export function findSource(sources: readonly ContextSource[], key: string): number {
  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= sources.length) return n - 1;
  const lower = key.toLowerCase();
  const exact = sources.findIndex((s) => s.name.toLowerCase() === lower);
  if (exact >= 0) return exact;
  const prefixed = sources.flatMap((s, i) => (s.name.toLowerCase().startsWith(lower) ? [i] : []));
  if (prefixed.length === 1) return prefixed[0];
  throw new Error(
    prefixed.length > 1
      ? `"${key}" matches ${prefixed.length} sources; use the row number`
      : `no source named "${key}"; run without --show to list them`,
  );
}

interface ShownSource extends ContextRow {
  text: string;
}

function formatReport(report: GroupContextReport): string {
  const lines: string[] = [];
  const doc = report.document ? `, ${report.document.fileName}` : '';
  lines.push(`Context for ${report.group.name} (${report.group.id})${doc}`);
  if (report.session?.recordedAt) {
    lines.push(
      `Runner sources as of ${formatLocalTime(report.session.recordedAt, TIMEZONE)}, session ${report.session.id}`,
    );
  }
  lines.push('');
  const width = (key: 'bytes' | 'tokens'): number =>
    Math.max(key.length, ...report.sources.map((r) => String(r[key]).length), String(report.total[key]).length);
  const bw = width('bytes');
  const tw = width('tokens') + 1;
  const sw = Math.max(6, ...report.sources.map((r) => r.status.length));
  const iw = String(report.sources.length).length;
  lines.push(`${'#'.padStart(iw)}  ${'STATUS'.padEnd(sw)}  ${'BYTES'.padStart(bw)}  ${'~TOKENS'.padStart(tw)}  SOURCE`);
  let layer: SourceLayer | undefined;
  for (const r of report.sources) {
    if (r.layer !== layer) {
      layer = r.layer;
      lines.push(`${' '.repeat(iw)}  [${layer}]`);
    }
    const detail = r.reason ? `${r.origin}; ${r.reason}` : r.origin;
    lines.push(
      `${String(r.index).padStart(iw)}  ${r.status.padEnd(sw)}  ${String(r.bytes).padStart(bw)}  ${String(r.tokens).padStart(tw)}  ${r.name} (${detail})`,
    );
  }
  lines.push('');
  lines.push(
    `Always in context: ${report.total.bytes} bytes, ~${report.total.tokens} tokens (${report.tokenEstimate}). ` +
      'Not counted: the provider base prompt and on-demand skills.',
  );
  return lines.join('\n');
}

const ARGS = [
  { name: 'id', type: 'string' as const, description: 'Agent group ID.', required: true },
  { name: 'show', type: 'string' as const, description: 'Print one source: its row number or name.' },
  {
    name: 'session',
    type: 'string' as const,
    description: "Session whose runner sources to read (default: the group's most recently active).",
  },
];

const contextOperation: CustomOperation = {
  access: 'open',
  description:
    "List every source of an agent group's context in compose order: the project document's sections, " +
    "the runner's system-prompt addendum, memory, and on-demand skills. Each row gives its status " +
    '(included, truncated, dropped, excluded, empty, shadowed, on-demand, not-measured) and why, its size in ' +
    'bytes, and a token estimate (characters / 4). The project document is composed fresh, exactly as the next ' +
    'spawn would; the addendum and memory are what the runner recorded at its last start. ' +
    '--show <row|name> prints that source as composed.',
  args: ARGS,
  examples: ['ncl groups context --id <group-id>', 'ncl groups context --id <group-id> --show "NanoClaw Module: core"'],
  handler: async (args) => {
    const { report, sources } = await groupContextSources(
      args.id as string,
      (args.session as string | undefined) || undefined,
    );
    if (args.show === undefined) return report;
    const i = findSource(sources, String(args.show));
    return { ...report.sources[i], text: sources[i].text } satisfies ShownSource;
  },
  formatHuman: (data) => {
    const shown = data as ShownSource | GroupContextReport;
    if ('text' in shown) {
      return shown.text === ''
        ? `${shown.name}: ${shown.status}${shown.reason ? ` (${shown.reason})` : ''}; nothing in context`
        : shown.text;
    }
    return formatReport(shown);
  },
};

const groups = getResource('groups');
if (groups) {
  // Listed with the resource's own verbs, so `ncl groups help` shows it.
  groups.customOperations = { ...groups.customOperations, context: contextOperation };
}
register({
  name: 'groups-context',
  action: 'groups.context',
  description: contextOperation.description,
  access: contextOperation.access,
  resource: 'groups',
  parseArgs: (raw) => validateArgs(ARGS, normalizeArgs(raw)),
  handler: (args, ctx) => contextOperation.handler(args, ctx),
  formatHuman: contextOperation.formatHuman,
});
