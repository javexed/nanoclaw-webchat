/**
 * collectVersions — what this install is running.
 *
 * The contract worth testing is not the happy path, it is the DEGRADATION.
 * This reads four independent sources (package.json, .webchat-provenance.json,
 * nanoclaw's versions.json, git) and any of them can be absent for legitimate
 * reasons: a tarball install has no git, an install composed before the
 * provenance stamp existed has no stamp, and a stripped image may have neither.
 * A partial answer is useful; a 500 because one file is missing is not.
 *
 * Note the versions.json trap encoded below: the file the INSTALL carries is
 * nanoclaw's (onecli + agent-image pins). The nanoclaw-webchat repo has a file
 * of the same name that pins the build inputs, and it is never copied in. They
 * are unrelated, and reading one expecting the other is the mistake this test
 * exists to keep out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { checkComposition, collectVersions } from './server.js';

let root: string;

beforeEach(() => {
  // Under os.tmpdir(), which is outside any git checkout — so the git probe
  // fails the way it would on a tarball install rather than picking up THIS
  // repo's HEAD and making the "no git" case untestable.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'versions-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (name: string, obj: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(obj));

describe('collectVersions', () => {
  it('reports every source when they are all present', () => {
    write('package.json', { name: 'nanoclaw', version: '2.1.54' });
    write('.webchat-provenance.json', {
      webchatRef: 'a'.repeat(40),
      webchatDirty: false,
      upstreamRef: 'b'.repeat(40),
      seamRef: 'c'.repeat(40),
      composedAt: '2026-08-14T12:00:00+00:00',
    });
    write('versions.json', { 'onecli-gateway': '1.36.0', 'onecli-cli': '2.2.5' });

    const v = collectVersions(root);
    expect(v.nanoclaw.version).toBe('2.1.54');
    expect(v.webchat).toMatchObject({
      ref: 'a'.repeat(40),
      dirty: false,
      upstreamRef: 'b'.repeat(40),
      seamRef: 'c'.repeat(40),
    });
    expect(v.components).toEqual({ 'onecli-gateway': '1.36.0', 'onecli-cli': '2.2.5' });
  });

  it('returns webchat: null when the provenance stamp is absent', () => {
    // An install composed before the stamp existed. It must still report the
    // nanoclaw half rather than failing, and must NOT invent a webchat version.
    write('package.json', { version: '2.1.54' });
    const v = collectVersions(root);
    expect(v.webchat).toBeNull();
    expect(v.nanoclaw.version).toBe('2.1.54');
  });

  it('survives a completely empty directory', () => {
    const v = collectVersions(root);
    expect(v.nanoclaw.version).toBeNull();
    expect(v.webchat).toBeNull();
    expect(v.components).toEqual({});
  });

  it('reports no commit outside a git checkout instead of throwing', () => {
    write('package.json', { version: '2.1.54' });
    const v = collectVersions(root);
    expect(v.nanoclaw.commit).toBeNull();
  });

  it('survives malformed JSON in any source', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{ not json');
    fs.writeFileSync(path.join(root, '.webchat-provenance.json'), 'nope');
    fs.writeFileSync(path.join(root, 'versions.json'), '[[[');
    const v = collectVersions(root);
    expect(v.nanoclaw.version).toBeNull();
    expect(v.webchat).toBeNull();
    expect(v.components).toEqual({});
  });

  it('carries the dirty flag through, so a modified tree cannot masquerade as its SHA', () => {
    write('package.json', { version: '2.1.54' });
    write('.webchat-provenance.json', { webchatRef: 'd'.repeat(40), webchatDirty: true });
    const v = collectVersions(root);
    expect(v.webchat?.dirty).toBe(true);
  });

  it('keeps only string component values, so a nested pin object cannot leak in', () => {
    write('versions.json', { 'onecli-cli': '2.2.5', nested: { secret: 'x' }, n: 3 });
    const v = collectVersions(root);
    expect(v.components).toEqual({ 'onecli-cli': '2.2.5' });
  });
});

describe('checkComposition', () => {
  const stamp = (root: string, files: Record<string, string>) =>
    fs.writeFileSync(path.join(root, '.webchat-payload.json'), JSON.stringify({ algorithm: 'sha256', files }));
  const sha = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

  it('reports a match when every payload file is untouched', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub/b.txt'), 'two');
    stamp(root, { 'a.txt': sha('one'), 'sub/b.txt': sha('two') });
    expect(checkComposition(root)).toEqual({ checked: 2, drifted: [], matches: true });
  });

  it('names an edited file, and counts a deleted one as drift', () => {
    // The two ways a live tree actually stops matching its release: someone
    // hand-copies a fixed file in, or something removes one.
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    fs.writeFileSync(path.join(root, 'b.txt'), 'two');
    stamp(root, { 'a.txt': sha('one'), 'b.txt': sha('two'), 'gone.txt': sha('three') });
    fs.writeFileSync(path.join(root, 'b.txt'), 'two-modified');
    const r = checkComposition(root)!;
    expect(r.matches).toBe(false);
    expect(r.checked).toBe(3);
    expect(r.drifted).toEqual(['b.txt', 'gone.txt']);
  });

  it('is null without a stamp, so "not checked" cannot read as "clean"', () => {
    // An install composed before this existed must not claim to be verified.
    expect(checkComposition(root)).toBeNull();
  });
});
