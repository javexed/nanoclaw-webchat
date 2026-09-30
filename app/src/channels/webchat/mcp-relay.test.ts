import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ getDb: () => ({ get: async () => undefined }) }));

afterEach(async () => {
  const relay = await import('./mcp-relay.js');
  relay.stopMcpRelay();
  delete process.env.WEBCHAT_EXEC_RELAY;
  delete process.env.WEBCHAT_MCP_RELAY_PORT;
  vi.resetModules();
});

describe('the MCP relay under the exec relay', () => {
  it('listens on loopback, where central reaches it for relayed agents, bridge or no bridge', async () => {
    process.env.WEBCHAT_EXEC_RELAY = '1';
    process.env.WEBCHAT_MCP_RELAY_PORT = String(40000 + Math.floor(Math.random() * 20000));
    vi.resetModules();
    const relay = await import('./mcp-relay.js');
    relay.registerRelayRoute('/probe', async (_req, res) => void res.writeHead(200).end('relay here'));
    relay.startMcpRelay();
    const target = relay.mcpRelayTarget();
    expect(target.host).toBe('127.0.0.1');
    let text = '';
    for (let i = 0; i < 50 && !text; i++) {
      text = await fetch(`http://127.0.0.1:${target.port}/probe`)
        .then((r) => r.text())
        .catch(() => '');
      if (!text) await new Promise((r) => setTimeout(r, 20));
    }
    expect(text).toBe('relay here');
  });

  it('without it, central reaches the relay where containers do', async () => {
    vi.resetModules();
    const relay = await import('./mcp-relay.js');
    process.env.WEBCHAT_MCP_RELAY_HOST = '198.51.100.7';
    expect(relay.mcpRelayTarget().host).toBe('198.51.100.7');
    delete process.env.WEBCHAT_MCP_RELAY_HOST;
  });
});
