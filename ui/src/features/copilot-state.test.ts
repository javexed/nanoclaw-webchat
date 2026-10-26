import { describe, expect, it } from 'vitest';

import { copilotConnectedText, copilotStatusLine } from './copilot-state.js';

describe('copilotConnectedText', () => {
  it('names the account, plan and endpoint host', () => {
    expect(
      copilotConnectedText({
        connected: true,
        login: 'octo',
        plan: 'business',
        apiUrl: 'https://api.business.githubcopilot.com',
      }),
    ).toBe('Copilot connected — octo · business · api.business.githubcopilot.com');
  });

  it('leaves out what is unknown, and survives a malformed endpoint', () => {
    expect(copilotConnectedText({ connected: true, plan: 'business', apiUrl: 'not a url' })).toBe(
      'Copilot connected — business',
    );
    expect(copilotConnectedText({ connected: true })).toBe('Copilot connected');
  });
});

describe('copilotStatusLine', () => {
  it('shows progress while running, nothing before the first message', () => {
    expect(copilotStatusLine({ running: true, message: 'Checking the Copilot seat…' })).toBe(
      'Checking the Copilot seat…',
    );
    expect(copilotStatusLine({ running: true })).toBeNull();
  });

  it('says why a finished sign-in did not complete, and nothing after success', () => {
    expect(copilotStatusLine({ running: false, outcome: 'expired', error: 'The device code expired.' })).toBe(
      'The device code expired.',
    );
    expect(copilotStatusLine({ running: false, outcome: 'failed' })).toBe('The sign-in did not complete.');
    expect(copilotStatusLine({ running: false, outcome: 'complete' })).toBeNull();
    expect(copilotStatusLine(null)).toBeNull();
  });
});
