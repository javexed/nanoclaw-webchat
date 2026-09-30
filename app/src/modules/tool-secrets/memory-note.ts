/**
 * Keep each agent's memory truthful about what it can reach.
 *
 * A vault credential is invisible to the agent by design (the gateway injects
 * it on the wire), so an agent that doesn't know it exists concludes it has no
 * access and stops — a skill instruction to "try first" loses to its (correct)
 * refusal instinct about credentials.
 *
 * So the panel writes the capability into the agent's memory — the HOSTS it can
 * authenticate to, never the values. Same rule as SSH keys: memory holds the
 * pointer, never the secret.
 *
 * WHERE IT GOES. Detail lands in `memory/system/credential-access.md`, an
 * OKF-typed concept file. The always-loaded surface is `memory/index.md`
 * (renderMemorySection embeds its CONTENT at startup, after clear and after
 * compaction), so a short delimited pointer goes there too — discovery is the
 * whole point, and a concept file nobody opens would not help.
 *
 * NEVER CREATES `index.md` (see step 2 below): if it is not there yet the
 * pointer is skipped, and the next sync after the group's first run lands it.
 *
 * Both writes are delimited and rewritten wholesale, so they stay idempotent
 * and the agent's own surrounding memory is never touched.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { readNoFollow, removeNoFollow, writeNoFollow } from '../../no-follow-fs.js';

const START = '<!-- nanoclaw:credentials:start -->';
const END = '<!-- nanoclaw:credentials:end -->';
/** OKF concept file holding the detail; linked from the always-loaded index. */
const CONCEPT_REL = path.join('memory', 'system', 'credential-access.md');
const INDEX_REL = path.join('memory', 'index.md');
/** Keep the always-loaded pointer small — the index has a 16k char budget. */
const INLINE_HOST_CAP = 8;

/** OKF concept file: frontmatter + the full guidance. */
function renderConcept(hosts: string[], keys: { name: string; path: string; target?: string }[]): string {
  const body = renderBlock(hosts, keys);
  if (!body) return '';
  return [
    '---',
    'type: capability',
    'title: Credential access',
    'description: Hosts this agent authenticates to automatically, and SSH keys available to it.',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * The always-loaded pointer. Short by design: index.md is embedded verbatim in
 * every session prompt under a 16k budget, and a long host list would crowd out
 * the agent's own Core Memory. Enough to stop it concluding it has no access.
 */
function renderIndexPointer(hosts: string[], keys: { name: string; path: string; target?: string }[]): string {
  if (!hosts.length && !keys.length) return '';
  const shown = hosts.slice(0, INLINE_HOST_CAP);
  const rest = hosts.length - shown.length;
  const out = [START, '', '## Credential access', ''];
  if (hosts.length) {
    out.push(
      `You authenticate automatically to: ${shown.map((h) => `\`${h}\``).join(', ')}` +
        (rest > 0 ? `, and ${rest} more` : '') +
        '. Just make the request — never ask anyone for a credential.',
    );
  }
  if (keys.length) {
    out.push(`${keys.length} SSH key${keys.length === 1 ? '' : 's'} available to you.`);
  }
  out.push('', `Detail: [Credential access](system/credential-access.md)`, '', END);
  return out.join('\n');
}

function renderBlock(hosts: string[], keys: { name: string; path: string; target?: string }[]): string {
  if (!hosts.length && !keys.length) return '';
  const out = ['## Credential access', ''];
  if (hosts.length) {
    out.push(
      'These hosts authenticate automatically — credentials are injected by the OneCLI',
      'gateway at the proxy, so just make the request (`git clone`, `curl`, `fetch`).',
      'You will never see the credential, and you must never ask anyone for one.',
      'A 401 from one of these hosts means the vault needs attention — say so, and stop.',
      '',
      ...hosts.map((h) => `- \`${h}\``),
      '',
    );
  }
  if (keys.length) {
    out.push(
      'SSH keys available to you. Use the exact command shown — the login user is',
      'part of it, so do not guess usernames. Never print a private key, never paste',
      'one into a message, and never ask anyone for one.',
      '',
      ...keys.map((k) =>
        k.target ? `- ${k.name}: \`ssh -i ${k.path} ${k.target}\`` : `- ${k.name}: \`${k.path}\` (no target recorded)`,
      ),
      '',
    );
  }
  return out.join('\n').trimEnd();
}

/**
 * Rewrite a group's managed credential note (concept file + index pointer).
 * Best-effort: a missing group folder or unwritable file must never fail the
 * secret operation that triggered it — the credential is already wired, and a
 * stale note is a much smaller problem than a half-applied write.
 */
export async function syncCredentialNote(
  agentGroupId: string,
  hosts: string[],
  keys: { name: string; path: string; target?: string }[] = [],
): Promise<void> {
  try {
    const group = await getAgentGroup(agentGroupId);
    if (!group) return;
    const groupDir = path.join(GROUPS_DIR, group.folder);
    if (!fs.existsSync(groupDir)) return;

    const sorted = Array.from(new Set(hosts)).sort();
    const concept = renderConcept(sorted, keys);
    const pointer = renderIndexPointer(sorted, keys);

    // The group folder is mounted read-write into the agent's container, so
    // any path under it may be a link the agent planted: every access below
    // refuses to follow one (no-follow-fs).

    // 1. Concept file — wholly machine-owned, so write or remove it outright.
    if (concept) writeIfChanged(groupDir, CONCEPT_REL, concept);
    else removeNoFollow(groupDir, CONCEPT_REL);

    // 2. Index pointer — the agent owns this file, so only ever splice the
    // delimited block. Never CREATE it: the container scaffolds memory with
    // COPYFILE_EXCL, and a host-created index would permanently suppress the
    // real template.
    const index = readNoFollow(groupDir, INDEX_REL);
    if (index !== null) writeIfChanged(groupDir, INDEX_REL, spliceBlock(index, pointer));

    // 3. Retire any block left in CLAUDE.local.md: the Claude harness still
    // auto-loads it, so a stale copy would assert access the agent may lack.
    const legacy = readNoFollow(groupDir, 'CLAUDE.local.md');
    if (legacy?.includes(START)) writeIfChanged(groupDir, 'CLAUDE.local.md', spliceBlock(legacy, ''));

    log.info('Credential note synced', { agentGroupId, hosts: hosts.length, keys: keys.length });
  } catch (err) {
    log.warn('Could not sync credential note', { agentGroupId, err });
  }
}

function writeIfChanged(root: string, rel: string, next: string): void {
  let prior: string | null = null;
  try {
    prior = readNoFollow(root, rel);
  } catch {
    /* a link (or not a file) at this name: replace it */
  }
  if (prior !== next) writeNoFollow(root, rel, next);
}

/**
 * Replace (or remove) the delimited block in `prior`, leaving everything the
 * agent wrote around it untouched. An empty `block` removes it and collapses
 * the blank line it leaves behind.
 */
function spliceBlock(prior: string, block: string): string {
  const from = prior.indexOf(START);
  const to = prior.indexOf(END);
  if (from !== -1 && to !== -1 && to > from) {
    const head = prior.slice(0, from).replace(/\n+$/, '');
    const tail = prior.slice(to + END.length).replace(/^\n+/, '');
    if (!block) return `${head}${tail ? `\n\n${tail}` : '\n'}`;
    return `${head}\n\n${block}\n${tail ? `\n${tail}` : ''}`;
  }
  if (!block) return prior;
  return prior.trimEnd() + (prior.trim() ? '\n\n' : '') + block + '\n';
}
