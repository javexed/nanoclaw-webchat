/**
 * The words around an approval-gated `ncl` command: who can approve it and
 * where (pending), and the approved outcome — summaries, known failures with
 * their fix, redaction of signed URLs and tokens, the length cap — including
 * through the CLI seam that dispatch calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { approvalPendingWords, approvedResultWords, register } from '../../cli/registry.js';
import type { RequestFrame, ResponseFrame } from '../../cli/frame.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { createUser } from '../permissions/db/users.js';
import { getApprovalHandler } from './primitive.js';
import type { PendingApproval } from '../../types.js';
// Registers the cli_command approval handler (dispatch.ts).
import '../../cli/dispatch.js';
import {
  capText,
  describeApprovedOutcome,
  explainFailure,
  humanName,
  listNames,
  outcomeText,
  pendingWords,
  redactResultText,
  registerApprovalVenue,
  takeApprovedOutcome,
} from './words.js';

/** The real build failure an approved `ncl workloads up` returned (signature shortened). */
const SIG =
  'j-Ez6ZJCemLqgXY~G18YMSiwmIwr9bM4JqZpRrhaOSRnq-PVoJDPaYIY7Ptw~500UkI29zsMSr6P6y9KW9IjWttdrYn9LP3ya0whLykaCuAXWDMK6rVusV5iBKi9-~r0oSJ4lkywQXUQYgz3XcAV4fdvcJaxjZk6kn~41cuatpnrCv~5HNbDg30R7K-diQKKhDFZ-ANve~0HPsZsShy7m20dDEtUXj5YbH0ppNrxGEpeNIoGBUqaWnYXvmYqWo8h5MY2tUILAbb4EDNrbxvw0H3sOO8fxjFpr2CHi66YnFt7a8lk5kKqv~geCaG1CACvR7I-v81JLDJ8rse3Npsxrg__';
const BUILD_ERROR =
  `the build failed: lobs/sha256/ae/ae59e9992c6b3e963dd9dac9c476287048177ad8f90ac646669afb738705f56d/data?Expires=1793502918&Signature=${SIG}&Key-Pair-Id=K31B9XRZB58O8Z": Forbidden\n` +
  '------\n > [internal] load metadata for docker.io/library/node:22-alpine:\n------\nDockerfile:1\n' +
  '--------------------\n   1 | >>> FROM node:22-alpine\n   2 |     WORKDIR /app\n--------------------\n' +
  'ERROR: failed to build: failed to solve: node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: ' +
  'failed to copy: httpReadSeeker: failed open: failed to do request: Get "https://production.cloudfront.docker.com/registry-v2/docker/registry/v2/blobs/sha256/ae/ae59e9992c6b3e963dd9dac9c476287048177ad8f90ac646669afb738705f56d/data' +
  `?Expires=1793502918&Signature=${SIG}&Key-Pair-Id=K31B9XRZB58O8Z": Forbidden\n`;

const frame = (command: string, args: Record<string, unknown> = {}): RequestFrame => ({ id: 'r1', command, args });
const ok = (data: unknown): ResponseFrame => ({ id: 'r1', ok: true, data });

describe('redactResultText', () => {
  it('strips the signed URL query strings from the real build failure', () => {
    const out = redactResultText(BUILD_ERROR);
    expect(out).not.toContain('Signature=j-Ez');
    expect(out).not.toContain('Expires=1793502918');
    expect(out).not.toContain('K31B9XRZB58O8Z');
    expect(out).not.toContain(SIG.slice(0, 40));
    // What helps stays: the digest, the host, the reason.
    expect(out).toContain('ae59e9992c6b3e963dd9dac9c476287048177ad8f90ac646669afb738705f56d');
    expect(out).toContain('production.cloudfront.docker.com');
    expect(out).toContain('Forbidden');
  });

  it('redacts X-Amz-* and sig= parameters, long base64 and token-looking strings', () => {
    // Built at run time, so the source holds nothing secret-shaped.
    const awsKey = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
    const apiKey = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const out = redactResultText(
      `GET https://b.s3.amazonaws.com/k?X-Amz-Credential=${awsKey}%2F&X-Amz-Signature=abc123 ` +
        'blob.core.windows.net/c/f?sv=2020&sig=Zm9vYmFyYmF6 ' +
        'payload aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHN0cmluZw9876 ' +
        `key ${apiKey}`,
    );
    expect(out).not.toMatch(/X-Amz-Signature=abc/);
    expect(out).not.toContain(awsKey);
    expect(out).not.toContain('Zm9vYmFyYmF6');
    expect(out).not.toContain('aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0');
    expect(out).not.toContain(apiKey);
  });

  it('keeps the quote that closes a URL in escaped JSON', () => {
    expect(redactResultText('{"e":"Get \\"https://h.example/a/b?Expires=1&Signature=x\\": Forbidden"}')).toBe(
      '{"e":"Get \\"https://h.example/a/b?[redacted]\\": Forbidden"}',
    );
  });

  it('leaves ordinary text alone', () => {
    const s = 'deployed homeboard: running at 198.18.0.10, image node:22-alpine';
    expect(redactResultText(s)).toBe(s);
  });
});

describe('capText', () => {
  it('keeps the start and the end of long text', () => {
    const long = `START ${'x'.repeat(5000)} END`;
    const out = capText(long, 200);
    expect(out.length).toBeLessThan(220);
    expect(out.startsWith('START')).toBe(true);
    expect(out.endsWith('END')).toBe(true);
    expect(out).toContain('…');
  });
});

describe('explainFailure', () => {
  it('names the Docker Hub cause and where an admin allows it', () => {
    expect(explainFailure(BUILD_ERROR)).toBe(
      "The build couldn't reach Docker Hub to fetch its base image. An admin can allow it for this agent: Agent → Apps → Allow Docker Hub for builds.",
    );
  });

  it('falls back to the first redacted line', () => {
    expect(explainFailure('could not remove x: busy\nmore')).toBe('could not remove x: busy.');
  });
});

describe('describeApprovedOutcome', () => {
  it('summarizes a deploy in one line, with the raw view under Details', () => {
    const o = describeApprovedOutcome(
      frame('workloads-up', { name: 'homeboard' }),
      ok({ name: 'homeboard', state: 'running', services_private: { web: '198.18.0.10' }, error: null }),
    );
    expect(o.failed).toBe(false);
    expect(o.line).toBe('Approved and done. Deployed "homeboard": running (web at 198.18.0.10).');
    expect(o.details).toContain('"state": "running"');
  });

  it('turns the real failed deploy into cause + fix, redacted and capped', () => {
    const o = describeApprovedOutcome(
      frame('workloads-up', { name: 'homeboard' }),
      ok({ name: 'homeboard', state: 'failed', services_private: { web: '198.18.0.10' }, error: BUILD_ERROR }),
    );
    expect(o.failed).toBe(true);
    expect(o.line).toMatch(/^Approved\. Deployed "homeboard", but it failed: The build couldn't reach Docker Hub/);
    expect(o.line).toContain('Agent → Apps → Allow Docker Hub for builds');
    expect(o.details).not.toContain('Signature=');
    // The error text itself, not the escaped JSON around it.
    expect(o.details).toContain('ERROR: failed to build');
    expect(o.details).not.toContain('"state"');
    expect(o.details.length).toBeLessThanOrEqual(1210);
  });

  it.each([
    ['workloads-redeploy', { name: 'w', state: 'running' }, 'Redeployed "w": running.'],
    ['workloads-start', { name: 'w', state: 'running' }, 'Started "w": running.'],
    ['workloads-restore', { name: 'w', state: 'running' }, 'Restored "w": running.'],
    ['workloads-stop', { name: 'w', state: 'stopped' }, 'Stopped "w"; its data is kept.'],
    ['workloads-down', { name: 'w', state: 'down' }, 'Removed the containers of "w"; its data volumes are kept.'],
    ['workloads-delete', { name: 'w', state: 'deleted' }, 'Deleted "w" and its data.'],
    [
      'workloads-expose',
      { app: 'board', url: 'https://board.example.ts.net/', who: 'only-me' },
      'Published "board" at https://board.example.ts.net/ (who can open it: only-me).',
    ],
    [
      'workloads-unexpose',
      { app: 'board', unpublished: true },
      'Stopped publishing "board"; the workload keeps running.',
    ],
    ['groups-config-add-mcp-server', { added: 'calendar' }, 'Added the MCP server "calendar".'],
  ])('%s', (command, data, text) => {
    expect(describeApprovedOutcome(frame(command), ok(data)).line).toBe(`Approved and done. ${text}`);
  });

  it('names the settings a config update changed, not the scope flags', () => {
    const o = describeApprovedOutcome(
      frame('groups-config-update', { id: 'ag-1', group: 'ag-1', agent_group_id: 'ag-1', model: 'x', timezone: 'UTC' }),
      ok({ model: 'x', restarted: true }),
    );
    expect(o.line).toBe(
      "Approved and done. Updated this agent's settings (model, timezone); it restarted to apply them.",
    );
  });

  it('summarizes a created task', () => {
    const o = describeApprovedOutcome(
      frame('tasks-create'),
      ok({ series_id: 'homeboard-inbox-9015', process_after: '2026-11-02T13:15:00.000Z', recurrence: '* * * * *' }),
    );
    expect(o.line).toMatch(
      /^Approved and done\. Scheduled the task "homeboard-inbox-9015", first run .+ \(repeats: \* \* \* \* \*\)\.$/,
    );
  });

  it('falls back to a generic line with the JSON under Details', () => {
    const o = describeApprovedOutcome(frame('members-add'), ok({ user: 'u', group: 'g' }));
    expect(o.line).toBe('Approved and done (`ncl members-add`).');
    expect(outcomeText(o)).toBe(`${o.line}\n\nDetails:\n${JSON.stringify({ user: 'u', group: 'g' }, null, 2)}`);
  });

  it('words a refused replay as a failure with its cause', () => {
    const o = describeApprovedOutcome(frame('workloads-up'), {
      id: 'r1',
      ok: false,
      error: { code: 'handler-error', message: 'workloads are off on this host (an operator turns them on)' },
    });
    expect(o.line).toBe(
      'Approved, but `ncl workloads-up` failed: Workloads are off on this host. An operator turns them on.',
    );
  });
});

describe('the CLI seam', () => {
  it('approvedResultWords returns the formatted outcome and keeps it for the card', () => {
    const text = approvedResultWords({
      approvalId: 'appr-seam',
      frame: frame('workloads-stop'),
      response: ok({ name: 'w' }),
    });
    expect(text).toBe('Approved and done. Stopped "w"; its data is kept.');
    expect(takeApprovedOutcome('appr-seam')?.line).toBe(text);
    expect(takeApprovedOutcome('appr-seam')).toBeUndefined();
  });

  it('the approved cli_command handler tells the agent the formatted outcome, not raw JSON', async () => {
    register({
      name: 'words-test-open',
      description: 'test',
      resource: 'groups',
      access: 'open',
      parseArgs: (raw) => raw,
      handler: async () => ({ secret: `see https://x.example/p?Signature=${SIG}` }),
    });
    const notify = vi.fn(async (_t: string) => {});
    const approval = { approval_id: 'appr-h', action: 'cli_command' } as PendingApproval;
    await getApprovalHandler('cli_command')!({
      session: {} as never,
      payload: { frame: frame('words-test-open'), callerContext: { caller: 'host' } },
      approval,
      userId: 'u',
      notify,
    });
    const text = notify.mock.calls[0][0];
    expect(text.startsWith('Approved and done (`ncl words-test-open`).')).toBe(true);
    expect(text).not.toContain('Signature=j-Ez');
    expect(text).not.toContain('was approved and executed');
  });
});

describe('pending words', () => {
  beforeEach(async () => {
    await initTestDb();
    await runMigrations(getDb());
    const now = new Date().toISOString();
    for (const [id, name] of [
      ['webchat:tailscale:alice.smith@example.com', 'alice.smith@example.com'],
      ['webchat:tailscale:bob@example.com', 'bob@example.com'],
    ]) {
      await createUser({ id, kind: 'webchat', display_name: name, created_at: now });
    }
    await grantRole({
      user_id: 'webchat:tailscale:alice.smith@example.com',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    await grantRole({
      user_id: 'webchat:tailscale:bob@example.com',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
  });
  afterEach(async () => {
    registerApprovalVenue(null);
    await closeDb();
  });

  const ctx = { caller: 'agent' as const, sessionId: 's', agentGroupId: 'ag-1', messagingGroupId: 'mg-room' };

  it('says the card is right here, and who can approve it, when an approver is in the room', async () => {
    registerApprovalVenue(async (mg, approvers) =>
      mg === 'mg-room' ? approvers.filter((a) => a.includes('alice')) : null,
    );
    const text = await approvalPendingWords(ctx);
    expect(text).toBe(
      'Approval card posted in this conversation. Alice Smith (owner) can approve it right here. ' +
        'If you are talking with them, ask them to approve the card above. You will be told the result.',
    );
  });

  it('points at Admin → Approvals when nobody who can approve is in the room', async () => {
    registerApprovalVenue(async () => []);
    expect(await pendingWords(ctx)).toBe(
      'Approval request sent to Bob (admin) or Alice Smith (owner) in Admin → Approvals; nobody who can approve it is in this conversation. You will be told the result.',
    );
  });

  it('a host caller keeps dispatch’s own text', async () => {
    expect(await approvalPendingWords({ caller: 'host' })).toBeUndefined();
  });
});

describe('names', () => {
  it('humanName', () => {
    expect(humanName('alice.smith@example.com')).toBe('Alice Smith');
    expect(humanName('Bob V')).toBe('Bob V');
  });
  it('listNames', () => {
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A or B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B or C');
    expect(listNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C or 2 others');
  });
});
