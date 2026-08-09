/**
 * The webchat Instructions editor writes the PROVIDER-NEUTRAL standing
 * instructions file, `instructions.prepend.md` — the one claude-md-compose
 * reads via readGroupPersona() and emits as the persona fragment for every
 * provider.
 *
 * It used to write `CLAUDE.local.md`, which nanoclaw stopped composing. That
 * file is still loaded by the Claude harness (settingSources includes 'local'),
 * so the editor appeared to work while being silently provider-local: nothing
 * saved reached a Codex-backed group, and switching provider dropped it.
 *
 * These tests pin the contract at the filesystem boundary — which file is read,
 * which is written, and that a symlink cannot turn a save into a write outside
 * the group folder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { PERSONA_PREPEND_FILE, readGroupPersona } from '../../group-persona.js';

let dir: string;
let outside: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/** The write half of the endpoint, verbatim in shape (see writeInstructions). */
function writePersona(groupDir: string, text: string): { ok: boolean; symlinkRefused?: boolean } {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o644,
    );
    fs.writeFileSync(fd, text.trimEnd() ? `${text.trimEnd()}\n` : '');
    return { ok: true };
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'ELOOP') return { ok: false, symlinkRefused: true };
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

describe('instructions editor writes the provider-neutral surface', () => {
  it('round-trips through the same file claude-md-compose reads', () => {
    writePersona(dir, 'Always answer in metric units.');
    // readGroupPersona is what composes the persona fragment — if the editor
    // and the composer disagree on the path, this is where it shows.
    expect(readGroupPersona(dir)).toBe('Always answer in metric units.');
    expect(fs.existsSync(path.join(dir, PERSONA_PREPEND_FILE))).toBe(true);
  });

  it('does NOT write CLAUDE.local.md — the pre-cutover, Claude-only surface', () => {
    writePersona(dir, 'some instructions');
    expect(fs.existsSync(path.join(dir, 'CLAUDE.local.md'))).toBe(false);
  });

  it('leaves an existing legacy file untouched (migration is /migrate-memory’s job)', () => {
    const legacy = path.join(dir, 'CLAUDE.local.md');
    fs.writeFileSync(legacy, 'pre-cutover content');
    writePersona(dir, 'new standing instructions');
    expect(fs.readFileSync(legacy, 'utf-8')).toBe('pre-cutover content');
    expect(readGroupPersona(dir)).toBe('new standing instructions');
  });

  it('refuses to follow a symlink instead of writing through it', () => {
    const target = path.join(outside, 'victim.md');
    fs.writeFileSync(target, 'do not clobber me');
    fs.symlinkSync(target, path.join(dir, PERSONA_PREPEND_FILE));

    const r = writePersona(dir, 'attacker content');
    expect(r.symlinkRefused, 'a planted symlink must not become an arbitrary-file write').toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('do not clobber me');
  });

  it('an empty save clears the instructions rather than writing a stray newline', () => {
    writePersona(dir, 'something');
    writePersona(dir, '   \n  ');
    expect(readGroupPersona(dir)).toBeNull();
  });
});
