import { describe, expect, it } from 'bun:test';

import { failureNotice } from './failure-notice.js';

describe('failureNotice', () => {
  it('names a model its server no longer has, as each endpoint reports it', () => {
    // OpenCode → Ollama's OpenAI API (an error wrapped in the provider's JSON).
    expect(
      failureNotice(
        'OpenCode prompt failed: {"name":"APIError","data":{"message":"model \'qwen3:8b-ctx12k\' not found","statusCode":404}}',
      ),
    ).toBe('The model “qwen3:8b-ctx12k” is no longer available. Pick another model for this agent, or reinstall it.');
    // Claude Code → Ollama's Anthropic API, quotes escaped inside the body.
    expect(failureNotice('API Error: 404 {"error":{"message":"model \\"mistral:7b\\" not found"}}')).toContain(
      '“mistral:7b”',
    );
    // The LiteLLM router, for a cloud model it no longer serves.
    expect(
      failureNotice('API Error: 400 litellm.BadRequestError: Invalid model name passed in model=command-a-03-2025.'),
    ).toContain('“command-a-03-2025”');
  });

  it('leaves every other failure to the generic notice', () => {
    expect(failureNotice('API Error: 529 overloaded')).toBeNull();
    expect(failureNotice('fetch failed')).toBeNull();
    expect(failureNotice(undefined)).toBeNull();
    expect(failureNotice('')).toBeNull();
  });
});
