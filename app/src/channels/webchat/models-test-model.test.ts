import { describe, expect, it } from 'vitest';

import { shortModelError } from './models.js';

describe('shortModelError', () => {
  it("gives the provider's own reason from a LiteLLM error, in a few words", () => {
    const body = JSON.stringify({
      error: {
        message: `litellm.APIConnectionError: Cohere_chatException - {"id":"x","message":"model 'North' not found, make sure the correct model ID was used."}. Received Model Group=North`,
      },
    });
    expect(shortModelError(500, body)).toBe("model 'North' not found, make sure the correct model ID was used");
  });

  it('takes error.message, a bare error string or plain text, and the status when empty', () => {
    expect(shortModelError(401, JSON.stringify({ error: { message: 'Incorrect API key provided' } }))).toBe(
      'Incorrect API key provided',
    );
    expect(shortModelError(404, JSON.stringify({ error: 'model not found' }))).toBe('model not found');
    expect(shortModelError(502, '')).toBe('HTTP 502');
  });
});
