import { describe, it, expect } from 'vitest';

import { buildMcpServerConfig, validateMcpServerName } from './mcp-server-config.js';

describe('validateMcpServerName', () => {
  it('accepts letters, numbers, dash, underscore', async () => {
    expect(validateMcpServerName('windows-mcp_1')).toBe('windows-mcp_1');
  });
  it('trims surrounding whitespace', async () => {
    expect(validateMcpServerName('  x ')).toBe('x');
  });
  it('rejects empty / non-string', async () => {
    expect(() => validateMcpServerName('')).toThrow(/required/);
    expect(() => validateMcpServerName(undefined)).toThrow(/required/);
  });
  it('rejects spaces and special characters', async () => {
    expect(() => validateMcpServerName('bad name!')).toThrow(/letters/);
  });
});

describe('buildMcpServerConfig', () => {
  it('builds a stdio server, defaulting args/env', async () => {
    expect(buildMcpServerConfig({ command: 'x' })).toEqual({ command: 'x', args: [], env: {} });
    expect(buildMcpServerConfig({ command: 'mcp-thing', args: ['--x'], env: { A: '1' } })).toEqual({
      command: 'mcp-thing',
      args: ['--x'],
      env: { A: '1' },
    });
  });
  it('builds a remote server, defaulting type to sse', async () => {
    expect(buildMcpServerConfig({ url: 'http://h:8000/sse' })).toEqual({
      type: 'sse',
      url: 'http://h:8000/sse',
      headers: {},
    });
  });
  it('honours type http + headers', async () => {
    expect(
      buildMcpServerConfig({ url: 'https://h/mcp', type: 'http', headers: { Authorization: 'Bearer t' } }),
    ).toEqual({ type: 'http', url: 'https://h/mcp', headers: { Authorization: 'Bearer t' } });
  });
  it('carries instructions on either transport', async () => {
    expect(buildMcpServerConfig({ command: 'x', instructions: 'hi' }).instructions).toBe('hi');
    expect(buildMcpServerConfig({ url: 'http://h', instructions: 'hi' }).instructions).toBe('hi');
  });
  it('rejects both url and command', async () => {
    expect(() => buildMcpServerConfig({ url: 'http://h', command: 'x' })).toThrow(/not both/);
  });
  it('rejects neither url nor command', async () => {
    expect(() => buildMcpServerConfig({})).toThrow(/required/);
  });
  it('rejects an invalid remote type', async () => {
    expect(() => buildMcpServerConfig({ url: 'http://h', type: 'ws' })).toThrow(/sse or http/);
  });
});
