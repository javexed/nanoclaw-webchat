import { describe, expect, it } from 'vitest';

import { CLICK_SLOP_PX, clampSize, nextPreset, readStoredSize, sizeForDrag, sizeForKey, sizeText, startPress } from './resizer.js';

const limits = { min: 180, max: 480, step: 20 };

describe('keyboard resizing', () => {
  const right = { ...limits, growsToward: 'right' as const };
  const left = { ...limits, growsToward: 'left' as const };

  it('arrows step toward the edge the panel grows to', () => {
    expect(sizeForKey('ArrowRight', 220, right)).toBe(240);
    expect(sizeForKey('ArrowLeft', 220, right)).toBe(200);
    // A right-hand drawer grows when its separator moves left.
    expect(sizeForKey('ArrowLeft', 220, left)).toBe(240);
    expect(sizeForKey('ArrowRight', 220, left)).toBe(200);
  });

  it('Home and End go to the limits', () => {
    expect(sizeForKey('Home', 300, right)).toBe(180);
    expect(sizeForKey('End', 300, right)).toBe(480);
  });

  it('never steps past a limit', () => {
    expect(sizeForKey('ArrowRight', 470, right)).toBe(480);
    expect(sizeForKey('ArrowLeft', 190, right)).toBe(180);
  });

  it('leaves every other key alone (Tab must still move focus)', () => {
    for (const k of ['Tab', 'Enter', ' ', 'ArrowUp', 'a']) expect(sizeForKey(k, 220, right)).toBeNull();
  });
});

describe('dragging', () => {
  it('follows the pointer in the growing direction, within the limits', () => {
    expect(sizeForDrag(220, 35, { ...limits, growsToward: 'right' })).toBe(255);
    expect(sizeForDrag(220, 35, { ...limits, growsToward: 'left' })).toBe(185);
    expect(sizeForDrag(220, 900, { ...limits, growsToward: 'right' })).toBe(480);
    expect(sizeForDrag(220, -900, { ...limits, growsToward: 'right' })).toBe(180);
  });
});

describe('the remembered size', () => {
  it('reads back a stored size, clamped to the current limits', () => {
    expect(readStoredSize('300', 180, 480)).toBe(300);
    expect(readStoredSize('9000', 180, 480)).toBe(480);
    expect(readStoredSize('12', 180, 480)).toBe(180);
  });

  it('treats nothing or junk as no size, so the default applies', () => {
    for (const raw of [null, '', '  ', 'wide', 'NaN', 'Infinity']) expect(readStoredSize(raw, 180, 480)).toBeNull();
  });

  it('rounds to whole pixels', () => {
    expect(clampSize(250.6, 180, 480)).toBe(251);
  });
});

describe('click to cycle (resizing without dragging)', () => {
  const presets = [180, 220, 360];

  it('steps narrow → default → wide → narrow', () => {
    expect(nextPreset(180, presets)).toBe(220);
    expect(nextPreset(220, presets)).toBe(360);
    expect(nextPreset(360, presets)).toBe(180);
  });

  it('from a dragged size, goes to the next preset up', () => {
    expect(nextPreset(200, presets)).toBe(220);
    expect(nextPreset(300, presets)).toBe(360);
    expect(nextPreset(470, presets)).toBe(180);
  });

  it('does not depend on the order presets are given in', () => {
    expect(nextPreset(220, [360, 180, 220])).toBe(360);
  });

  it('announces the size in words, not a bare number', () => {
    expect(sizeText(220)).toBe('220 pixels');
  });
});

describe('a press: click or drag', () => {
  it('is a click when it never moves past the slop', () => {
    const p = startPress(100);
    expect(p.move(102)).toBe(false);
    expect(p.isClick(101)).toBe(true);
  });

  it('is a drag once past the slop, even if it ends where it started', () => {
    const p = startPress(100);
    expect(p.move(100 + CLICK_SLOP_PX)).toBe(true);
    expect(p.move(100)).toBe(true);
    expect(p.isClick(100)).toBe(false);
  });

  it('is not a click when released past the slop without a move event', () => {
    expect(startPress(100).isClick(100 - CLICK_SLOP_PX)).toBe(false);
  });
});
