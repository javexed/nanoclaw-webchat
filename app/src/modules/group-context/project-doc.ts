/**
 * The project-document half of `ncl groups context`: what the composer would
 * write for a group on its next spawn, broken into the sources it came from.
 *
 * Nothing here decides what goes in. The composer runs for real, as a dry run,
 * with an observer that hears each decision as it is made; this file only
 * labels what it heard and cuts the composed text back into its blocks. That
 * keeps the view honest by construction: if the composer changes, the view
 * changes with it, and the byte-for-byte test fails if the cut ever drifts.
 */
import fs from 'fs';
import path from 'path';

import { parseSkillSelection } from '../../container-config.js';
import { GROUPS_DIR } from '../../config.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { selectGatewayAgentSkills } from '../../gateway-providers/index.js';
import {
  BASE_INSTRUCTIONS_PATH,
  composeGroupProjectDoc,
  DEFAULT_PROJECT_DOC,
  type ProjectDocSpec,
} from '../../project-doc-compose.js';
import { availableSkillNames, providerProjectDocSpec } from '../../provider-contracts/realize.js';
import { getProviderHostContract } from '../../provider-contracts/registry.js';
import { resolveProviderName } from '../../providers/provider-name.js';
import { providerProvidesAgentSurfaces } from '../../providers/provider-container-registry.js';
import type { AgentGroup } from '../../types.js';

export type SourceStatus =
  | 'included'
  | 'truncated'
  | 'dropped'
  | 'excluded'
  | 'empty'
  | 'shadowed'
  | 'on-demand'
  | 'not-measured';

/** Where a source lands. Only `project-doc`, `system-prompt` and `memory` are always in context. */
export type SourceLayer = 'project-doc' | 'system-prompt' | 'memory' | 'provider' | 'on-demand';

export interface ContextSource {
  name: string;
  layer: SourceLayer;
  /** File, config field, or component the text comes from. */
  origin: string;
  status: SourceStatus;
  reason?: string;
  /** Exactly the text this source contributes, separators included; '' when nothing. */
  text: string;
}

export interface ProjectDocManifest {
  /** The group's provider, as a spawn would resolve it from the container config. */
  provider: string;
  /** Undefined when the provider composes its own document and core never sees it. */
  fileName?: string;
  maxBytes?: number;
  /** The whole document, as the composer produced it. */
  content: string;
  sources: ContextSource[];
}

interface ObservedEvent {
  name: string;
  kind: 'considered' | 'empty' | 'excluded';
  reason?: string;
}

/**
 * The spec and skill list a spawn would hand the composer. Mirrors the two
 * call sites in container-runner: a provider with a host contract composes
 * through realize with no explicit skill list (the composer reads the stored
 * selection itself); a provider with neither a contract nor its own surfaces
 * gets the default document and the resolved skill names.
 */
function spawnComposeInputs(
  provider: string,
  storedSkills: string | undefined,
  groupName: string,
): { spec?: ProjectDocSpec; runtimeSkills?: string[]; ownSurfaces?: true } {
  const contract = getProviderHostContract(provider);
  if (contract) return { spec: providerProjectDocSpec(contract) };
  if (providerProvidesAgentSurfaces(provider)) return { ownSurfaces: true };
  const selection = parseSkillSelection(storedSkills, groupName);
  return {
    spec: DEFAULT_PROJECT_DOC,
    runtimeSkills: selectGatewayAgentSkills(selection === 'all' ? availableSkillNames() : selection),
  };
}

function originFor(name: string, group: AgentGroup, spec: ProjectDocSpec, provider: string): string {
  if (name === 'Persona') return path.join('groups', group.folder, 'instructions.prepend.md');
  if (name === 'NanoClaw Runtime Contract') return spec.baseDocPath ?? BASE_INSTRUCTIONS_PATH;
  if (name === 'Omitted for size') return 'size cap notice';
  let m = name.match(/^NanoClaw Module: (.+)$/);
  if (m) return path.join('container', 'agent-runner', 'src', 'mcp-tools', `${m[1]}.instructions.md`);
  m = name.match(/^NanoClaw Skill: (.+)$/);
  if (m) return path.join('container', 'skills', m[1], 'instructions.md');
  m = name.match(/^MCP Server: (.+)$/);
  if (m) return `container config: mcp_servers.${m[1]}.instructions`;
  return `provider contract: ${provider}`;
}

/** Compose the group's project document as a dry run and attribute every byte. */
export async function projectDocManifest(group: AgentGroup): Promise<ProjectDocManifest> {
  const configRow = await getContainerConfig(group.id);
  const provider = resolveProviderName(null, configRow?.provider);
  const inputs = spawnComposeInputs(provider, configRow?.skills, group.name);
  if (!inputs.spec) {
    const reason = inputs.ownSurfaces
      ? `provider '${provider}' writes its own instruction files`
      : `provider '${provider}' declares no project document`;
    return {
      provider,
      content: '',
      sources: [
        { name: 'Project document', layer: 'project-doc', origin: provider, status: 'not-measured', reason, text: '' },
      ],
    };
  }
  const spec = inputs.spec;

  const events: ObservedEvent[] = [];
  let composed: { content: string; header: string; blocks: readonly { name: string; text: string }[] } | undefined;
  await composeGroupProjectDoc(group, path.resolve(GROUPS_DIR, group.folder), spec, inputs.runtimeSkills, {
    considered: (name, empty) => events.push({ name, kind: empty ? 'empty' : 'considered' }),
    excluded: (name, reason) => events.push({ name, kind: 'excluded', reason }),
    composed: (content, header, blocks) => {
      composed = { content, header, blocks };
    },
  });
  if (!composed) throw new Error('Project document composer returned without a document');
  const { content, header, blocks } = composed;

  // Cut the document back into pieces. Each piece carries the separator that
  // follows it, so the pieces concatenate to the document exactly.
  const pieces = [header, ...blocks.map((b) => b.text)].map((p) => p + '\n\n');
  const joined = pieces.join('');
  let notice: string | undefined;
  if (content === joined.slice(0, -1)) {
    // The document ends with one newline, not a separator.
    pieces[pieces.length - 1] = pieces[pieces.length - 1].slice(0, -1);
  } else if (content.startsWith(joined)) {
    // The size cap appended its notice after the surviving blocks.
    notice = content.slice(joined.length);
  } else {
    throw new Error('Composed document does not match its blocks');
  }

  const sources: ContextSource[] = [
    { name: 'Composed header', layer: 'project-doc', origin: 'composer', status: 'included', text: pieces[0] },
  ];
  if (!events.some((e) => e.name === 'Persona')) {
    sources.push({
      name: 'Persona',
      layer: 'project-doc',
      origin: originFor('Persona', group, spec, provider),
      status: 'excluded',
      reason: 'no standing instructions',
      text: '',
    });
  }
  const capNote = spec.maxBytes === undefined ? '' : ` (${spec.maxBytes} bytes)`;
  let next = 0;
  for (const event of events) {
    const origin = originFor(event.name, group, spec, provider);
    if (event.kind === 'excluded') {
      // An unselected skill is only a source if it ships resident prose.
      if (event.name.startsWith('NanoClaw Skill: ') && !fs.existsSync(path.resolve(process.cwd(), origin))) continue;
      sources.push({
        name: event.name,
        layer: 'project-doc',
        origin,
        status: 'excluded',
        reason: event.reason,
        text: '',
      });
    } else if (event.kind === 'empty') {
      sources.push({ name: event.name, layer: 'project-doc', origin, status: 'empty', reason: 'blank', text: '' });
    } else if (blocks[next]?.name === event.name) {
      next++;
      sources.push({ name: event.name, layer: 'project-doc', origin, status: 'included', text: pieces[next] });
    } else {
      sources.push({
        name: event.name,
        layer: 'project-doc',
        origin,
        status: 'dropped',
        reason: `dropped to fit the size cap${capNote}`,
        text: '',
      });
    }
  }
  if (notice) {
    sources.push({
      name: 'Omitted for size',
      layer: 'project-doc',
      origin: 'size cap notice',
      status: 'included',
      text: notice,
    });
  }

  return { provider, fileName: spec.fileName, maxBytes: spec.maxBytes, content, sources };
}
