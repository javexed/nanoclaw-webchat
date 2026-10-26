import fs from 'node:fs';
import path from 'node:path';

import * as p from '@clack/prompts';

import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { registerSetupProvider } from './registry.js';

/** The pins the skill installs; SKILL.md's nc:dep and nc:json-merge carry the same values (a test checks). */
export const COPILOT_SDK_VERSION = '1.0.24';
export const COPILOT_CLI_VERSION = '1.0.101';

export function verifyCopilotInstall(root = process.cwd()): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const requiredFiles = [
    'src/providers/copilot.ts',
    'src/provider-contracts/copilot.ts',
    'container/agent-runner/src/providers/copilot.ts',
    'container/agent-runner/src/providers/copilot-mcp.ts',
    'container/agent-runner/src/provider-contracts/copilot.ts',
    'setup/providers/copilot.ts',
    'scripts/copilot-login.ts',
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of [
    'src/providers/index.ts',
    'src/provider-contracts/index.ts',
    'container/agent-runner/src/providers/index.ts',
    'container/agent-runner/src/provider-contracts/index.ts',
    'setup/providers/index.ts',
  ]) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './copilot.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const toolsPath = path.join(root, 'container', 'cli-tools.json');
  try {
    const tools = JSON.parse(fs.readFileSync(toolsPath, 'utf-8')) as Array<{ name?: string; version?: string }>;
    if (!tools.some((tool) => tool.name === '@github/copilot' && tool.version === COPILOT_CLI_VERSION)) {
      problems.push(`container/cli-tools.json missing @github/copilot@${COPILOT_CLI_VERSION}`);
    }
  } catch {
    problems.push('container/cli-tools.json is not readable JSON');
  }

  const pkgPath = path.join(root, 'container', 'agent-runner', 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, string> };
    if (pkg.dependencies?.['@github/copilot-sdk'] !== COPILOT_SDK_VERSION) {
      problems.push(`container/agent-runner/package.json missing @github/copilot-sdk@${COPILOT_SDK_VERSION}`);
    }
  } catch {
    problems.push('container/agent-runner/package.json is not readable JSON');
  }

  return { ok: problems.length === 0, problems };
}

export async function runCopilotInstallCheck(root = process.cwd()): Promise<void> {
  p.log.step(brandBody('Checking the GitHub Copilot provider install...'));
  const { ok, problems } = verifyCopilotInstall(root);
  if (ok) {
    setupLog.step('copilot-install', 'success', 0, {});
    p.log.success(brandBody('GitHub Copilot provider installed properly.'));
    return;
  }
  setupLog.step('copilot-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The GitHub Copilot provider is not fully installed:'));
  for (const problem of problems) console.log(`   ${problem}`);
  throw new Error(`GitHub Copilot provider is not fully installed: ${problems.join('; ')}`);
}

registerSetupProvider({
  value: 'copilot',
  label: 'GitHub Copilot',
  hint: 'GitHub Copilot seat, signed in with a device code',
  runAuth: async () => {
    const auth = await import('../../scripts/copilot-login.js');
    await auth.runCopilotLogin();
  },
  runInstallCheck: runCopilotInstallCheck,
});
