// ── GitHub Copilot card text ────────────────────────────────────────────────
// Pure: what the wizard's Copilot card says for a status or a sign-in in
// progress. Kept out of wizard.ts so it is testable without a DOM.

export interface CopilotStatusView {
  connected?: boolean;
  login?: string;
  plan?: string;
  apiUrl?: string;
}

export interface CopilotProgressView {
  running?: boolean;
  outcome?: string | null;
  message?: string | null;
  error?: string | null;
}

/** "Copilot connected — octo · business · api.business.githubcopilot.com". */
export function copilotConnectedText(s: CopilotStatusView): string {
  let host: string | undefined;
  try {
    host = s.apiUrl ? new URL(s.apiUrl).host : undefined;
  } catch {
    host = undefined;
  }
  const parts = [s.login, s.plan, host].filter((p): p is string => !!p);
  return parts.length ? `Copilot connected — ${parts.join(' · ')}` : 'Copilot connected';
}

/** The status line under the card: progress while it runs, the reason when it did not complete, else nothing. */
export function copilotStatusLine(p: CopilotProgressView | null | undefined): string | null {
  if (!p) return null;
  if (p.running) return p.message ?? null;
  if (p.outcome && p.outcome !== 'complete') return p.error || 'The sign-in did not complete.';
  return null;
}
