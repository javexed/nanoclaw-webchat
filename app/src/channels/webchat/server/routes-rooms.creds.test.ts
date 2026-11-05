/**
 * Room credential settings (mode, OAuth toggle): the owner, or an admin of an
 * agent wired to the room who can also access the room — every agent in it.
 * Admin of one agent alone is not enough.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: false,
  adminOf: new Set<string>(),
  canAccess: false,
  sent: [] as { status: number; body: unknown }[],
  setMode: vi.fn(),
  setOauth: vi.fn(),
}));

vi.mock('./http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./http.js')>()),
  json: (_res: unknown, status: number, body: unknown) => {
    h.sent.push({ status, body });
  },
  readJsonObject: async (req: { body: unknown }) => req.body,
}));
vi.mock('../roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../roles.js')>()),
  isOwner: async () => h.owner,
  hasAdminPrivilege: async (_u: string, agentId: string) => h.adminOf.has(agentId),
}));
vi.mock('../access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../access.js')>()),
  canAccessRoom: async () => h.canAccess,
}));
vi.mock('../db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db.js')>()),
  getWebchatRoom: async (id: string) => ({ id, name: id }),
  getAgentsForWebchatRoom: async () => [{ id: 'ag-a' }, { id: 'ag-b' }],
  setRoomModeOverride: h.setMode,
  setRoomOauthAllowed: h.setOauth,
}));

import { rRoomCredModePut, rRoomOauthPut } from './routes-rooms.js';

const call = async (fn: typeof rRoomCredModePut, body: unknown) => {
  h.sent = [];
  await fn({ req: { body }, res: {}, userId: 'u1' } as never, ['', 'room-1'] as unknown as RegExpMatchArray);
  return h.sent[0]!.status;
};

beforeEach(() => {
  h.owner = false;
  h.adminOf = new Set();
  h.canAccess = false;
  h.setMode.mockReset();
  h.setOauth.mockReset();
});

describe('room credential settings', () => {
  it('refuses an admin of one agent who cannot access the whole room', async () => {
    h.adminOf.add('ag-a');
    expect(await call(rRoomCredModePut, { mode: 'required' })).toBe(403);
    expect(await call(rRoomOauthPut, { allowed: true })).toBe(403);
    expect(h.setMode).not.toHaveBeenCalled();
    expect(h.setOauth).not.toHaveBeenCalled();
  });

  it('refuses a member with room access but no admin role', async () => {
    h.canAccess = true;
    expect(await call(rRoomCredModePut, { mode: 'required' })).toBe(403);
    expect(await call(rRoomOauthPut, { allowed: true })).toBe(403);
  });

  it('allows an admin who can access the room, and the owner', async () => {
    h.adminOf.add('ag-a');
    h.canAccess = true;
    expect(await call(rRoomCredModePut, { mode: 'required' })).toBe(200);
    expect(await call(rRoomOauthPut, { allowed: true })).toBe(200);
    h.adminOf.clear();
    h.canAccess = false;
    h.owner = true;
    expect(await call(rRoomCredModePut, { mode: 'inherit' })).toBe(200);
    expect(await call(rRoomOauthPut, { allowed: false })).toBe(200);
    expect(h.setMode).toHaveBeenCalledTimes(2);
    expect(h.setOauth).toHaveBeenCalledTimes(2);
  });
});
