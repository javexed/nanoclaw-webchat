/**
 * The runner half of `ncl groups context`: the system-prompt addendum and the
 * memory section, as a session's runner last recorded them (see the runner's
 * context-snapshot.ts), plus the skills an agent can load on demand.
 *
 * These are read, never rebuilt: the addendum depends on live destinations and
 * prompt-section contributors that only the runner assembles.
 */
import fs from 'fs';
import path from 'path';

import { AnchoredDir } from '../../anchored-dir.js';
import { DATA_DIR } from '../../config.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { selectGatewayAgentSkills } from '../../gateway-providers/index.js';
import { parseSkillSelection } from '../../container-config.js';
import { availableSkillNames } from '../../provider-contracts/realize.js';
import { openOutboundDb, outboundDbPath } from '../../session-db-access.js';
import type { AgentGroup, Session } from '../../types.js';
import type { ContextSource } from './project-doc.js';

/** Must match the key the runner writes (container/agent-runner/src/context-snapshot.ts). */
const CONTEXT_SNAPSHOT_KEY = 'context:snapshot';

interface RunnerSnapshot {
  recordedAt: string;
  provider: string;
  addendum: string;
  contributorSections: string[];
  memory: string;
  memoryTruncated: boolean;
  memoryBudgetChars: number;
}

export interface RuntimeContext {
  sessionId?: string;
  recordedAt?: string;
  provider?: string;
  sources: ContextSource[];
}

/** The session to read: the one asked for (it must be this group's), else the most recently active. */
export async function pickSession(group: AgentGroup, sessionId?: string): Promise<Session | undefined> {
  const sessions = await getSessionsByAgentGroup(group.id);
  if (sessionId) {
    const match = sessions.find((s) => s.id === sessionId);
    if (!match) throw new Error(`session not found: ${sessionId}`);
    return match;
  }
  const stamp = (s: Session): string => s.last_active ?? s.created_at;
  return [...sessions].sort((a, b) => stamp(b).localeCompare(stamp(a)))[0];
}

function readSnapshot(group: AgentGroup, session: Session): RunnerSnapshot | undefined {
  if (!fs.existsSync(outboundDbPath(group.id, session.id))) return undefined;
  const db = openOutboundDb(group.id, session.id);
  try {
    const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get(CONTEXT_SNAPSHOT_KEY) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as RunnerSnapshot) : undefined;
  } catch {
    // No session_state table yet, or a runner that predates the snapshot.
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * Cut the addendum at its headings. Each piece keeps the separator before the
 * next one, so the pieces concatenate back to the addendum exactly.
 */
export function splitAddendum(addendum: string): { heading: string; text: string }[] {
  const starts: number[] = [];
  const re = /(^|\n\n)(#{1,3} )/g;
  for (let m = re.exec(addendum); m; m = re.exec(addendum)) starts.push(m.index + m[1].length);
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
  return starts.map((start, i) => {
    const text = addendum.slice(start, starts[i + 1] ?? addendum.length);
    const heading = text.match(/^#{1,3} (.*)/)?.[1]?.trim() ?? '(untitled)';
    return { heading, text };
  });
}

function addendumOrigin(heading: string, text: string, contributors: readonly string[]): string {
  // A contributor section can carry its own subheadings, so a piece is one
  // when a contributor's text starts with it.
  if (contributors.some((c) => c.trimEnd().startsWith(text.trimEnd()))) return 'prompt-section contributor';
  if (heading.startsWith('You are ')) return 'assistant name';
  if (heading === 'Sending messages') return 'destinations';
  return 'runner addendum';
}

function skillDoc(name: string): string | undefined {
  for (const root of [
    path.join(process.cwd(), 'container', 'skills'),
    path.join(process.cwd(), 'data', 'user-skills'),
  ]) {
    const file = path.join(root, name, 'SKILL.md');
    if (fs.existsSync(file)) return path.relative(process.cwd(), file);
  }
  return undefined;
}

/**
 * Skills the agent loads only when it decides to: shared skills selected for
 * the group, and template skills stamped into the group's private store. A
 * private skill named like a shared one wins — the shared link is skipped —
 * so the shared one is listed as shadowed.
 */
async function onDemandSkills(group: AgentGroup): Promise<ContextSource[]> {
  const configRow = await getContainerConfig(group.id);
  const selection = parseSkillSelection(configRow?.skills, group.name);
  const shared = selectGatewayAgentSkills(selection === 'all' ? availableSkillNames() : selection).sort();
  // The group-private store is agent-writable (it is the claude-home volume),
  // so it is walked through descriptors: no planted link is ever followed.
  const privateSkills = new Map<string, string>();
  let store: AnchoredDir | null = null;
  try {
    store = AnchoredDir.open(path.join(DATA_DIR, 'v2-sessions', group.id), ['.claude-shared', 'skills']);
    const dir = store;
    for (const name of dir?.entries().sort() ?? []) {
      let skill: AnchoredDir | null = null;
      try {
        skill = dir?.openDir(name) ?? null;
        if (skill) privateSkills.set(name, skill.readFile('SKILL.md').toString('utf-8'));
      } catch {
        // Not a real directory, or no plain SKILL.md: not a skill the agent can load.
      } finally {
        skill?.close();
      }
    }
  } catch {
    // The store itself is not a real directory.
  } finally {
    store?.close();
  }
  const sources: ContextSource[] = [];
  for (const name of shared) {
    const doc = skillDoc(name);
    if (!doc) continue;
    const text = fs.readFileSync(path.join(process.cwd(), doc), 'utf-8');
    if (privateSkills.has(name)) {
      sources.push({
        name: `Skill: ${name}`,
        layer: 'on-demand',
        origin: doc,
        status: 'shadowed',
        reason: "the group's own skill of the same name wins",
        text,
      });
    } else {
      sources.push({ name: `Skill: ${name}`, layer: 'on-demand', origin: doc, status: 'on-demand', text });
    }
  }
  for (const [name, text] of privateSkills) {
    sources.push({
      name: `Group skill: ${name}`,
      layer: 'on-demand',
      origin: path.join('data', 'v2-sessions', group.id, '.claude-shared', 'skills', name, 'SKILL.md'),
      status: 'on-demand',
      text,
    });
  }
  return sources;
}

export async function runtimeContext(group: AgentGroup, provider: string, sessionId?: string): Promise<RuntimeContext> {
  const session = await pickSession(group, sessionId);
  const snapshot = session ? readSnapshot(group, session) : undefined;
  const sources: ContextSource[] = [];

  if (snapshot) {
    for (const piece of splitAddendum(snapshot.addendum)) {
      sources.push({
        name: piece.heading,
        layer: 'system-prompt',
        origin: addendumOrigin(piece.heading, piece.text, snapshot.contributorSections),
        status: 'included',
        text: piece.text,
      });
    }
    sources.push({
      name: 'Memory',
      layer: 'memory',
      origin: 'memory/index.md + memory/system/definition.md (session-start hook)',
      status: snapshot.memoryTruncated ? 'truncated' : 'included',
      reason: snapshot.memoryTruncated
        ? `a memory file ran past its ${snapshot.memoryBudgetChars}-character budget`
        : undefined,
      text: snapshot.memory,
    });
  } else {
    sources.push({
      name: 'System-prompt addendum and memory',
      layer: 'system-prompt',
      origin: 'agent runner',
      status: 'not-measured',
      reason: session ? 'no snapshot yet: recorded on the next container start' : 'the group has no session yet',
      text: '',
    });
  }
  sources.push({
    name: 'Provider base prompt',
    layer: 'provider',
    origin: snapshot?.provider ?? provider,
    status: 'not-measured',
    reason: "the provider's own system prompt is not visible to NanoClaw",
    text: '',
  });
  sources.push(...(await onDemandSkills(group)));

  return { sessionId: session?.id, recordedAt: snapshot?.recordedAt, provider: snapshot?.provider, sources };
}
