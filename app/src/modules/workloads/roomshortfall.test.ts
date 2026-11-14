/** A stack on a crowded worker may still be redeployed at the size it already has. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ getDb: () => ({}) }));
const { roomShortfall } = await import('./control.js');

describe('roomShortfall', () => {
  it('lets a same-size or smaller redeploy through however crowded the worker is', () => {
    expect(roomShortfall('w', 'App', -4665, 128, 128)).toBeNull();
    expect(roomShortfall('w', 'App', -4665, 64, 128)).toBeNull();
  });
  it('refuses growth the worker has no room for, and allows it when it has', () => {
    expect(roomShortfall('w', 'App', -4665, 256, 128)).toBe("w's worker App has 0 MB free for it, and this asks for 256 MB");
    expect(roomShortfall('w', 'App', 300, 256, 128)).toBeNull();
  });
});
