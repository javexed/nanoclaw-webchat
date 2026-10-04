import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { installRunnerLog } from './runner-log.js';

let uninstall: (() => void) | undefined;
let dir: string | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function logFile(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-log-'));
  return path.join(dir, '.agent-runner.log');
}

describe('runner log', () => {
  it('copies a console.error line into the file, once', () => {
    const file = logFile();
    uninstall = installRunnerLog(file);
    console.error('[poll-loop] runner-log marker %d', 42);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines.filter((l) => l.endsWith('[poll-loop] runner-log marker 42'))).toHaveLength(1);
  });

  it('copies a direct stderr write', () => {
    const file = logFile();
    uninstall = installRunnerLog(file);
    process.stderr.write('raw stderr marker\n');
    expect(fs.readFileSync(file, 'utf8')).toContain(' raw stderr marker\n');
  });

  it('recreates the file when it disappears', () => {
    const file = logFile();
    uninstall = installRunnerLog(file);
    console.error('first');
    fs.rmSync(file);
    console.error('second');
    expect(fs.readFileSync(file, 'utf8')).toContain(' second\n');
  });
});
