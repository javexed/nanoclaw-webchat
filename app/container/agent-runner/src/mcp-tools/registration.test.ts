/**
 * MCP tool registration — a malformed tool module must not take the whole
 * nanoclaw MCP server down (invisibly: chat keeps working). Three legs:
 *   1. every shipped tool module loads and registers well-formed definitions;
 *   2. the expected core tools are actually present by name;
 *   3. registerTools rejects malformed shapes instead of exploding later.
 */
import { describe, expect, it } from 'bun:test';

import { registeredTools, registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

// Same list as index.ts TOOL_MODULES (index.ts itself would start the stdio
// server on import, so the modules are loaded directly here).
await import('./core.js');
await import('./interactive.js');
await import('./agents.js');
await import('./self-mod.js');
await import('./draft-skill.js');

describe('MCP tool registry', () => {
  it('every registered definition is well-formed', () => {
    const tools = registeredTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.tool.name).toBe('string');
      expect(t.tool.name.length).toBeGreaterThan(0);
      expect(typeof t.tool.inputSchema).toBe('object');
      expect(typeof t.handler).toBe('function');
    }
  });

  it('the core tools agents are promised are present', () => {
    const names = new Set(registeredTools().map((t) => t.tool.name));
    for (const expected of ['send_message', 'send_file', 'add_reaction', 'ask_user_question']) {
      expect(names.has(expected), `missing tool: ${expected}`).toBe(true);
    }
  });

  it('registerTools skips a malformed (flat-shape) definition instead of throwing', () => {
    const before = registeredTools().length;
    const flat = { name: 'bogus_flat_tool', inputSchema: { type: 'object' }, handler: async () => ({ content: [] }) };
    expect(() => registerTools([flat as unknown as McpToolDefinition])).not.toThrow();
    expect(registeredTools().length).toBe(before);
    expect(registeredTools().some((t) => t.tool?.name === 'bogus_flat_tool')).toBe(false);
  });
});
