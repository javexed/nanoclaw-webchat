/**
 * Install-only entry for a manifest-style provider: the payload copy + barrel
 * wiring + CLI-manifest merge, WITHOUT auth or build.
 *
 * `provider-auth` bundles install + build + auth for the interactive setup flow.
 * The webchat "Install <provider>" button needs just the install half — build
 * (host + image) and the host restart are the caller's job, run and gated
 * separately so they can be streamed and a failure can abort before restart.
 *
 *   pnpm exec tsx setup/index.ts --step provider-install codex
 */
import { applyProviderSkill } from './providers/install.js';

// Mirror provider-auth.ts's map — the manifest-style providers whose install is
// a directive-engine apply of their SKILL.md (not a drift-prone add-<name>.sh).
const INSTALL_SKILLS: Record<string, string> = {
  codex: '.claude/skills/add-codex',
  // OpenCode: upstream's add-opencode skill installs the whole provider — its
  // payload, barrels, CLI pin and its own pinned SDK (nc:dep). add-opencode-stack
  // only points an installed OpenCode at a local backend, and installs nothing.
  opencode: '.claude/skills/add-opencode',
  // The pi stack: same directive-apply shape, no SDK dep (CLI-only harness).
  pi: '.claude/skills/add-pi-stack',
  // Grok: same directive-apply shape. Its payload lives on the providers-grok
  // branch, which the skill's nc:copy resolves through whichever remote carries
  // it — so a fresh install needs no private remote.
  grok: '.claude/skills/add-grok',
};

export async function run(args: string[]): Promise<void> {
  const name = args[0]?.trim().toLowerCase();
  const skillDir = name ? INSTALL_SKILLS[name] : undefined;
  if (!skillDir) {
    console.error(
      `Usage: pnpm exec tsx setup/index.ts --step provider-install <provider>\n` +
        `Known: ${Object.keys(INSTALL_SKILLS).join(', ')}`,
    );
    process.exit(1);
  }
  console.log(`Installing the ${name} provider payload…`);
  const { changed, blockers } = await applyProviderSkill(skillDir, process.cwd());
  if (blockers.length) {
    console.error(`Couldn't install ${name}: ${blockers.join('; ')}`);
    process.exit(1);
  }
  console.log(changed ? `${name} payload installed — rebuild + restart to load it.` : `${name} already present.`);
}
