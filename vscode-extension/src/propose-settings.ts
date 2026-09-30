// Propose-mode settings read where they are used. git-changes.ts also runs
// outside VS Code (tests, the runner harness), where there is no `vscode`
// module: there every setting takes its default.

import { userSetting } from './settings.js';

/**
 * `nanoclaw.proposeIncludeIgnored`: whether gitignored files go into the
 * proposal copy the agent works on. Off by default — ignored files are where
 * local config, dumps and credentials a secret pattern misses tend to live.
 * User settings only: a workspace's own settings may be the agent's writing,
 * and must not turn this on.
 */
export function proposeIncludeIgnored(): boolean {
  try {
    const vscode = require('vscode') as typeof import('vscode');
    return userSetting<unknown>(vscode.workspace.getConfiguration('nanoclaw'), 'proposeIncludeIgnored', false) === true;
  } catch {
    return false;
  }
}

/**
 * `nanoclaw.proposeSecretScanAllow`: globs the developer vouches for, copied
 * into the proposal whatever the secret scan finds in them. User settings
 * only: a workspace's own settings may be the agent's writing.
 */
export function proposeSecretScanAllow(): string[] {
  try {
    const vscode = require('vscode') as typeof import('vscode');
    const v = userSetting<unknown[]>(vscode.workspace.getConfiguration('nanoclaw'), 'proposeSecretScanAllow', []);
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  } catch {
    return [];
  }
}
