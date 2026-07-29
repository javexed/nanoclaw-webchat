/**
 * Keep each agent's `CLAUDE.local.md` truthful about what it can reach.
 *
 * A credential in the vault is invisible to the agent by design — the gateway
 * injects it on the wire. That solves secrecy but creates a DISCOVERY problem:
 * an agent with no idea a credential exists concludes it has no access and
 * stops, which is exactly what happened when the Drupal agent refused to clone
 * a repo whose PAT it could in fact have used. Its skill says "never say you
 * lack access without trying the request first", but that instruction competes
 * with a strong (and correct) refusal instinct about credentials.
 *
 * So the panel writes the capability into the agent's memory — the HOSTS it can
 * authenticate to, never the values. Same rule as SSH keys: memory holds the
 * pointer, never the secret.
 *
 * The block is delimited and rewritten wholesale, so it stays idempotent and an
 * operator's surrounding notes are never touched.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';

const START = '<!-- nanoclaw:credentials:start -->';
const END = '<!-- nanoclaw:credentials:end -->';

function renderBlock(hosts: string[], keys: { name: string; path: string; target?: string }[]): string {
  if (!hosts.length && !keys.length) return '';
  const out = [START, '', '## Credential access', ''];
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
  out.push(END);
  return out.join('\n');
}

/**
 * Rewrite the managed credential block in a group's `CLAUDE.local.md`.
 * Best-effort: a missing group folder or unwritable file must never fail the
 * secret operation that triggered it — the credential is already wired, and a
 * stale note is a much smaller problem than a half-applied write.
 */
export function syncCredentialNote(
  agentGroupId: string,
  hosts: string[],
  keys: { name: string; path: string; target?: string }[] = [],
): void {
  try {
    const group = getAgentGroup(agentGroupId);
    if (!group) return;
    const file = path.join(GROUPS_DIR, group.folder, 'CLAUDE.local.md');
    if (!fs.existsSync(path.dirname(file))) return;

    const prior = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const block = renderBlock(Array.from(new Set(hosts)).sort(), keys);

    let next: string;
    const from = prior.indexOf(START);
    const to = prior.indexOf(END);
    if (from !== -1 && to !== -1 && to > from) {
      // Replace in place, collapsing the blank line left behind when the block
      // is removed entirely (no hosts left).
      const head = prior.slice(0, from).replace(/\n+$/, '');
      const tail = prior.slice(to + END.length).replace(/^\n+/, '');
      next = block ? `${head}\n\n${block}\n${tail ? `\n${tail}` : ''}` : `${head}${tail ? `\n\n${tail}` : '\n'}`;
    } else if (block) {
      next = prior.trimEnd() + (prior.trim() ? '\n\n' : '') + block + '\n';
    } else {
      return; // nothing to add, nothing to remove
    }

    if (next !== prior) fs.writeFileSync(file, next);
    log.info('Credential note synced', { agentGroupId, hosts: hosts.length, keys: keys.length });
  } catch (err) {
    log.warn('Could not sync credential note', { agentGroupId, err });
  }
}
