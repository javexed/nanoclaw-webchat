/**
 * The overlap LLM judge calls the local router. Once the router serves a cloud
 * model it requires its master key, so the judge must send it — or every Keep
 * silently falls back to the heuristic.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dataDir: '' }));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<object>()),
  get DATA_DIR() {
    return h.dataDir;
  },
}));
vi.mock('../../db/skill-drafts.js', () => ({ listSkillDrafts: async () => [], readSkillDraftBody: () => '' }));
vi.mock('../../channels/webchat/cloud-models.js', () => ({
  routerAuthHeaders: (url: string) =>
    url.startsWith('http://127.0.0.1:4000/') ? { Authorization: 'Bearer sk-router' } : {},
}));

import { findKeepOverlaps } from './overlap.js';

beforeEach(() => {
  h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-judge-'));
  const dir = path.join(h.dataDir, 'v2-sessions', 'ag-1', '.claude-shared', 'skills', 'branded-pdf-documents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: branded-pdf-documents\ndescription: Generate branded letterhead PDF business documents via HTML and chromium print-to-pdf.\n---\n',
  );
  vi.stubEnv('NANOCLAW_OVERLAP_MODEL', 'judge');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(h.dataDir, { recursive: true, force: true });
});

describe('the overlap judge', () => {
  it('sends the router its master key', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ content: [{ text: '{"overlaps":[]}' }] })));
    await findKeepOverlaps({
      id: 'd1',
      agent_group_id: 'ag-1',
      session_id: null,
      kind: 'create',
      skill_name: 'branded-pdf-deliverables',
      target_skill: null,
      description: 'Generate branded PDF deliverables from HTML via headless chromium.',
      status: 'pending',
      created_at: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4000/v1/messages');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-router');
  });
});
