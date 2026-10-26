import { describe, expect, it } from 'vitest';

import { bumpUnread, firstUnreadIndex, formatUnreadCount, seedUnread } from './unread.js';

describe('the count badge', () => {
  it('says nothing at zero and caps at 99+', () => {
    expect(formatUnreadCount(0)).toBe('');
    expect(formatUnreadCount(undefined)).toBe('');
    expect(formatUnreadCount(-2)).toBe('');
    expect(formatUnreadCount(1)).toBe('1');
    expect(formatUnreadCount(99)).toBe('99');
    expect(formatUnreadCount(100)).toBe('99+');
    expect(formatUnreadCount(4321)).toBe('99+');
  });
});

describe('counting', () => {
  it('a live message adds one to whatever is there', () => {
    const m = new Map<string, number>();
    bumpUnread(m, 'eng');
    bumpUnread(m, 'eng');
    bumpUnread(m, 'ops');
    expect(m.get('eng')).toBe(2);
    expect(m.get('ops')).toBe(1);
  });

  it('the server count replaces the live tally, it does not add to it', () => {
    const m = new Map([['eng', 5]]);
    seedUnread(m, 'eng', 3);
    expect(m.get('eng')).toBe(3);
  });

  it('a flagged room with no count still reads as unread', () => {
    const m = new Map<string, number>();
    seedUnread(m, 'eng', undefined);
    seedUnread(m, 'ops', 0);
    expect(m.get('eng')).toBe(1);
    expect(m.get('ops')).toBe(1);
  });
});

describe('where the "New" divider goes', () => {
  const msgs = [
    { sender: 'bob', created_at: 100 },
    { sender: 'me', created_at: 200 },
    { type: 'system', created_at: 250 },
    { sender: 'me', created_at: 300 },
    { sender: 'agent', created_at: 400 },
    { sender: 'bob', created_at: 500 },
  ];

  it('before the first message newer than the marker', () => {
    expect(firstUnreadIndex(msgs, 350, 'me')).toBe(4);
  });

  it('strictly newer: a message at the marker was read', () => {
    expect(firstUnreadIndex(msgs, 400, 'me')).toBe(5);
  });

  it('skips my own messages and system lines', () => {
    expect(firstUnreadIndex(msgs, 150, 'me')).toBe(4);
  });

  it('nowhere when everything was read', () => {
    expect(firstUnreadIndex(msgs, 500, 'me')).toBe(-1);
  });

  it('nowhere on a first visit (no marker) — that lands at the latest', () => {
    expect(firstUnreadIndex(msgs, null, 'me')).toBe(-1);
    expect(firstUnreadIndex(msgs, undefined, 'me')).toBe(-1);
  });

  it('at the top when everything loaded is unread', () => {
    expect(firstUnreadIndex(msgs, 0, 'me')).toBe(0);
  });
});
