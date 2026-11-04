import { describe, expect, it } from 'vitest';

import { filterList, matchesQuery, normQuery } from './list-filter.js';

describe('list search', () => {
  const agents = [{ name: 'Docs Base' }, { name: 'ops-bot' }, { name: 'Research' }];
  const name = (a: { name: string }) => a.name;

  it('matches case-insensitively, anywhere in the name', () => {
    expect(filterList(agents, 'DOCS', name).map(name)).toEqual(['Docs Base']);
    expect(filterList(agents, 'bot', name).map(name)).toEqual(['ops-bot']);
  });

  it('shows everything for an empty or blank query, and nothing for a miss', () => {
    expect(filterList(agents, '', name)).toHaveLength(3);
    expect(filterList(agents, '   ', name)).toHaveLength(3);
    expect(filterList(agents, 'zzz', name)).toEqual([]);
  });

  it('matches any of several fields, ignoring missing ones', () => {
    expect(matchesQuery('ag-12', 'Research', 'ag-1234')).toBe(true);
    expect(matchesQuery('x', null, undefined)).toBe(false);
    expect(matchesQuery('', null)).toBe(true);
    expect(normQuery('  Foo ')).toBe('foo');
  });

});
