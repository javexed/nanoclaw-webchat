/**
 * Async skill-draft Keep (POST /api/skill-drafts/:id/keep).
 *
 * The overlap review is slow (optionally LLM-backed), so a plain Keep is
 * server-async: the route validates everything it always validated — draft
 * pending, CSRF, admin over the draft's group AND the target group — then
 * answers 202 { queued: true } and runs the review in the background,
 * pushing the outcome to the pressing user as a `skill_draft_review` WS
 * event. force / updateTarget skip the review and stay synchronous.
 *
 * The overlap module is mocked with a controllable impl so the background
 * job is deterministic (its own heuristics are covered in overlap.test.ts).
 * WS outcomes are captured via a stub client registered in state.ts.
 *
 * Same boot pattern as scoped-skill-auth.test.ts: identity per request via a
 * trusted proxy header.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { WebchatServer } from './server.js';
import type { DbDriver } from '../../db/driver.js';
import { httpRequest, loadServer, noopHooks, portOf, PROXY_ENV, resetServerModules, seeder } from './test-server.js';

const ctl = vi.hoisted(() => ({
  impl: (async () => []) as () => Promise<unknown[]>,
  calls: 0,
}));

vi.mock('../../modules/learning/overlap.js', () => ({
  findKeepOverlaps: () => {
    ctl.calls++;
    return ctl.impl();
  },
}));

const AG_A = 'ag-keep-async-a';
const AG_B = 'ag-keep-async-b';
const DRAFT = 'draft-keep-async-1';

beforeEach(async () => {
  vi.resetModules();
  ctl.impl = async () => [];
  ctl.calls = 0;
});

afterEach(async () => {
  await resetServerModules();
  // Drafts + kept skills land under the real DATA_DIR (cwd/data) — remove
  // exactly what these tests can create.
  fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts', DRAFT), { recursive: true, force: true });
  fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts', `${DRAFT}-twin`), { recursive: true, force: true });
  for (const g of [AG_A, AG_B]) {
    fs.rmSync(path.join(process.cwd(), 'data', 'v2-sessions', g), { recursive: true, force: true });
  }
});

const now = '2026-07-21T00:00:00.000Z';
async function seed(db: DbDriver): Promise<void> {
  const { group, role } = seeder(db, now);
  await group(AG_A);
  await group(AG_B);
  await role('webchat:owner', 'owner', null);
  await role('webchat:admina', 'admin', AG_A); // scoped admin of A only
  await role('webchat:adminb', 'admin', AG_B); // scoped admin of B only
}

async function stageDraft(id: string, agentGroupId: string, name: string, desc: string): Promise<void> {
  const drafts = await import('../../db/skill-drafts.js');
  await drafts.createSkillDraft({
    id,
    agent_group_id: agentGroupId,
    session_id: null,
    kind: 'create',
    skill_name: name,
    target_skill: null,
    description: desc,
    body: `---\nname: ${name}\ndescription: ${desc}\n---\nTest body`,
  });
}

const KEEP = (id: string, qs = '') => `/api/skill-drafts/${id}/keep${qs}`;
const asUser = (name: string) => ({
  'x-forwarded-user': name,
  'content-type': 'application/json',
  'x-webchat-csrf': '1',
});
const bodyFor = (group: string) => JSON.stringify({ agentGroupId: group });

describe('POST /api/skill-drafts/:id/keep — async review', () => {
  let server: typeof import('./server.js');
  let state: typeof import('./state.js');
  let wc: WebchatServer;
  let port: number;
  let sent: Array<Record<string, unknown>>;

  beforeEach(async () => {
    const loaded = await loadServer(PROXY_ENV);
    server = loaded.server;
    await seed(loaded.conn.getDb());
    await stageDraft(DRAFT, AG_A, 'zz-async-keep-test', 'unique async keep test skill zz');
    wc = await server.startWebchatServer(noopHooks);
    port = portOf(wc);
    // Stub WS client for webchat:owner so pushToUser outcomes are observable.
    state = await import('./state.js');
    sent = [];
    state.addClient({
      id: 'test-ws-owner',
      ws: { readyState: 1, send: (p: string) => sent.push(JSON.parse(p) as Record<string, unknown>) } as never,
      identity: 'owner',
      identity_type: 'user',
      userId: 'webchat:owner',
      isAlive: true,
    });
  });

  afterEach(async () => {
    state.removeClient('test-ws-owner');
    if (wc) await server.stopWebchatServer(wc);
  });

  // ── Auth — preserved exactly from the sync route ──────────────────────

  it('404 for an unknown draft', async () => {
    const r = await httpRequest(port, 'POST', KEEP('nope'), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(404);
  });

  it('403 without the CSRF header, even for the owner', async () => {
    const headers = { 'x-forwarded-user': 'owner', 'content-type': 'application/json' };
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), headers, bodyFor(AG_A));
    expect(r.status).toBe(403);
    expect(ctl.calls).toBe(0); // refused before any review
  });

  it("403 for an admin who does not administer the DRAFT's group", async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('adminb'), bodyFor(AG_B));
    expect(r.status).toBe(403);
    expect(ctl.calls).toBe(0);
  });

  it("403 for an admin of the draft's group who does not administer the TARGET group", async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('admina'), bodyFor(AG_B));
    expect(r.status).toBe(403);
    expect(ctl.calls).toBe(0);
  });

  it('404 for an unknown target group (checked before the review is queued)', async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor('ag-nope'));
    expect(r.status).toBe(404);
    expect(ctl.calls).toBe(0);
  });

  // ── Async plumbing ────────────────────────────────────────────────────

  it('202 { queued: true }, then a kept outcome pushed over the WS and the draft applied', async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ queued: true });

    await server.keepReviewJobFor(DRAFT); // undefined (already done) or the in-flight job
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = sent[0];
    expect(msg.type).toBe('skill_draft_review');
    expect(msg.draftId).toBe(DRAFT);
    expect(msg.outcome).toBe('kept');
    expect(msg.name).toBe('zz-async-keep-test');
    expect(msg.agentGroupId).toBe(AG_A);
    // The draft is resolved and the scoped skill written — same write path as before.
    const drafts = await import('../../db/skill-drafts.js');
    expect(await drafts.getSkillDraft(DRAFT)).toBeUndefined();
    const kept = path.join(
      process.cwd(),
      'data',
      'v2-sessions',
      AG_A,
      '.claude-shared',
      'skills',
      'zz-async-keep-test',
      'SKILL.md',
    );
    expect(fs.existsSync(kept)).toBe(true);
  });

  it('overlaps found → WS carries them and the draft STAYS pending for the re-drive', async () => {
    ctl.impl = async () => [{ name: 'existing-twin', source: 'scoped', reason: 'same job', description: '', score: 1 }];
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(202);

    await server.keepReviewJobFor(DRAFT);
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));

    const msg = sent[0];
    expect(msg.outcome).toBe('overlaps');
    expect(msg.overlaps).toEqual([{ name: 'existing-twin', source: 'scoped', reason: 'same job' }]);
    const drafts = await import('../../db/skill-drafts.js');
    expect((await drafts.getSkillDraft(DRAFT))?.status).toBe('pending');
  });

  it('refuses a same-draft double keep (409) while the review is in flight', async () => {
    let release!: () => void;
    ctl.impl = () =>
      new Promise((res) => {
        release = () => res([]);
      });
    const first = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(first.status).toBe(202);
    const second = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(second.status).toBe(409);

    const job = server.keepReviewJobFor(DRAFT);
    expect(job).toBeDefined();
    release();
    await job;
    // Job finished + map cleared — outcome was pushed.
    expect(server.keepReviewJobFor(DRAFT)).toBeUndefined();
    await vi.waitFor(() => expect(sent.length).toBe(1));
  });

  it('force=1 skips the review entirely and stays synchronous (200 + applied)', async () => {
    const r = await httpRequest(port, 'POST', KEEP(DRAFT, '?force=1'), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('zz-async-keep-test');
    expect(ctl.calls).toBe(0); // review never consulted
    const drafts = await import('../../db/skill-drafts.js');
    expect(await drafts.getSkillDraft(DRAFT)).toBeUndefined();
  });

  it('a concurrently-discarded draft yields an error outcome, not a keep', async () => {
    let release!: () => void;
    ctl.impl = () =>
      new Promise((res) => {
        release = () => res([]);
      });
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(202);
    // Discard while the review is parked — the job re-fetches and bails.
    const drafts = await import('../../db/skill-drafts.js');
    await drafts.resolveSkillDraft(DRAFT, 'discarded');
    const job = server.keepReviewJobFor(DRAFT);
    release();
    await job;
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0].outcome).toBe('error');
  });

  // A pending row whose BODY vanished passes the re-fetch and fails only at
  // apply (readSkillDraftBody → 410): the shape a stray `rm -rf
  // data/skill-drafts` produces.
  it("a draft whose body vanished mid-review reports 'Draft body missing', not a keep", async () => {
    let release!: () => void;
    ctl.impl = () =>
      new Promise((res) => {
        release = () => res([]);
      });
    const r = await httpRequest(port, 'POST', KEEP(DRAFT), asUser('owner'), bodyFor(AG_A));
    expect(r.status).toBe(202);

    // Row stays pending; only the on-disk body goes.
    fs.rmSync(path.join(process.cwd(), 'data', 'skill-drafts', DRAFT), { recursive: true, force: true });
    const drafts = await import('../../db/skill-drafts.js');
    expect((await drafts.getSkillDraft(DRAFT))?.status).toBe('pending');

    const job = server.keepReviewJobFor(DRAFT);
    release();
    await job;
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0].outcome).toBe('error');
    expect(sent[0].error).toBe('Draft body missing');
  });
});
