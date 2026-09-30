import { describe, expect, it } from 'vitest';

import { riskOf } from './host-run-paths.js';

describe('riskOf', () => {
  it('names what a proposed change could run, without case', () => {
    expect(riskOf('.vscode/settings.json')).toBe('runs code in VS Code');
    expect(riskOf('pkg/.VSCode/tasks.json')).toBe('runs code in VS Code');
    expect(riskOf('.devcontainer/devcontainer.json')).toBe('runs code in VS Code');
    expect(riskOf('.devcontainer.json')).toBe('runs code in VS Code');
    expect(riskOf('team.code-workspace')).toBe('runs code in VS Code');
    expect(riskOf('.husky/pre-commit')).toBe('git hook');
    expect(riskOf('.githooks/pre-push')).toBe('git hook');
    expect(riskOf('tools/hooks/pre-commit', {}, ['tools/hooks'])).toBe('git hook');
    expect(riskOf('lefthook.yml')).toBe('git hook');
    for (const f of [
      'lefthook.yaml',
      '.lefthook.yaml',
      'lefthook-local.yml',
      '.lefthook-local.yml',
      'lefthook.toml',
      'lefthook.json',
      '.config/lefthook.yml',
      'pkg/Lefthook.YML',
    ])
      expect(riskOf(f), f).toBe('git hook');
    expect(riskOf('docs/lefthook.md')).toBeNull();
    expect(riskOf('sub/.gitattributes')).toBe('changes git attributes');
    expect(riskOf('.gitmodules')).toBe('changes submodules');
    expect(riskOf('src/a.ts', { newMode: '120000' })).toBe('symbolic link');
    expect(riskOf('run.sh', { oldMode: '100644', newMode: '100755' })).toBe('makes a file executable');
    expect(riskOf('new.sh', { newMode: '100755' })).toBe('makes a file executable');
    expect(riskOf('run.sh', { oldMode: '100755', newMode: '100644' })).toBe('changes file mode');
  });

  it('leaves ordinary files alone', () => {
    expect(riskOf('src/app.ts', { oldMode: '100644', newMode: '100644' })).toBeNull();
    expect(riskOf('run.sh', { oldMode: '100755', newMode: '100755' })).toBeNull();
    expect(riskOf('gone.sh', { oldMode: '100755', newMode: '000000' })).toBeNull();
    expect(riskOf('docs/vscode.md')).toBeNull();
    expect(riskOf('tools/hooksmith.ts', {}, ['tools/hooks'])).toBeNull();
  });
});
