// Copy settings read where they are used. git-changes.ts also runs outside
// VS Code (tests), where there is no `vscode` module: there every setting
// takes its default. The settings themselves: copy-settings.ts.

import { ALL_IGNORED, copySettings, type CopySettings } from './copy-settings.js';

function read(): CopySettings | null {
  try {
    const vscode = require('vscode') as typeof import('vscode');
    return copySettings(vscode.workspace.getConfiguration('nanoclaw'));
  } catch {
    return null;
  }
}

/**
 * Whether every gitignored file goes into the copy (`*` in
 * `nanoclaw.agentCopy.includeIgnored`). Off by default: ignored files are where
 * local config, dumps and credentials a secret pattern misses tend to live.
 */
export function proposeIncludeIgnored(): boolean {
  return read()?.includeIgnored.includes(ALL_IGNORED) ?? false;
}

/** The gitignored folders or files listed in `nanoclaw.agentCopy.includeIgnored`, copied anyway. */
export function proposeIncludePaths(): string[] {
  return (read()?.includeIgnored ?? []).filter((p) => p !== ALL_IGNORED);
}

/** `nanoclaw.agentCopy.allowSecretsIn`: globs copied whatever the secret scan finds in them. */
export function proposeSecretScanAllow(): string[] {
  return read()?.allowSecretsIn ?? [];
}
