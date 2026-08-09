/**
 * Provider escalation (llm-router.md §16c) — as a turn-retry handler.
 *
 * When a turn fails on the group's primary provider (typically a cheap/local
 * model behind the router), re-run it ONCE on a stronger fallback. This used
 * to be ~154 lines patched into poll-loop.ts; the R5 turn-retry seam
 * (runner-hooks.ts) now owns the query lifecycle, so escalation is a
 * registration and the core patch is gone.
 *
 * THE CAP IS THE POINT. R5 deliberately does not decide whether retrying is
 * worth the money — core cannot know a provider's price. Retries spend real
 * quota, and a failing primary is exactly the condition that repeats: a dead
 * backend fails every turn, and a crafted prompt stream can fail a model on
 * purpose. Without a cap, every such turn silently bills the expensive
 * provider. So this module counts CONSECUTIVE escalations and stops at
 * NANOCLAW_ESCALATION_CAP (default 3), resetting on the first clean turn.
 *
 * Reset uses the exchange observer rather than `turn_done`, which fires on
 * failed turns too — a counter reset by turn_done would never actually cap
 * anything.
 */
import { registerTurnRetryHandler } from './runner-hooks.js';
import { registerProviderExchangeObserver } from './providers/hooks.js';
import { appendStatusEvent } from './status-feed.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import type { AgentProvider, McpServerConfig } from './providers/types.js';

function log(msg: string): void {
  console.log(`[escalation] ${msg}`);
}

/** `0` disables escalation entirely; a non-numeric value falls back to 3. */
function resolveCap(): number {
  const raw = process.env.NANOCLAW_ESCALATION_CAP;
  if (raw === undefined || raw.trim() === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

export interface EscalationOptions {
  /** Provider name from container config (`fallback_provider`). Empty = off. */
  fallbackName?: string | null;
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  additionalDirectories?: string[];
}

export function armEscalation(opts: EscalationOptions): void {
  const fallbackName = opts.fallbackName?.trim().toLowerCase();
  if (!fallbackName) return;

  const cap = resolveCap();
  if (cap === 0) {
    log(`fallback ${fallbackName} configured but NANOCLAW_ESCALATION_CAP=0 — escalation disabled`);
    return;
  }

  let fallback: AgentProvider;
  try {
    // Same options as the primary so MCP tools and identity carry over,
    // EXCEPT user settings: the group's settings.json env (a local-router
    // ANTHROPIC_BASE_URL under the direct path) beats process env, so the
    // fallback skips the 'user' scope entirely — its query must go to the
    // provider's real API, not back into the router that just failed.
    fallback = createProvider(fallbackName as ProviderName, {
      assistantName: opts.assistantName || undefined,
      mcpServers: opts.mcpServers,
      env: { ...process.env, ANTHROPIC_BASE_URL: undefined, ANTHROPIC_MODEL: undefined },
      additionalDirectories: opts.additionalDirectories?.length ? opts.additionalDirectories : undefined,
      settingSources: ['project', 'local'],
    });
  } catch (err) {
    log(`fallback unavailable (${fallbackName}): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let consecutive = 0;

  // A turn that actually delivered resets the budget. 'undelivered' does NOT
  // count as clean — it means the model answered into the void, which is
  // usually the same underlying fault that triggers escalation.
  registerProviderExchangeObserver((exchange) => {
    if (exchange.status === 'completed' && consecutive > 0) {
      log(`clean turn — escalation budget reset (was ${consecutive}/${cap})`);
      consecutive = 0;
    }
  });

  registerTurnRetryHandler(async (ctx) => {
    if (consecutive >= cap) {
      // Declining (null) hands the failure back to core, which surfaces the
      // ORIGINAL error — the user sees the real fault, not a silent stall.
      log(`escalation cap reached (${consecutive}/${cap}) — declining, surfacing the primary's error`);
      return null;
    }
    consecutive++;
    log(`escalating to ${fallbackName} (${consecutive}/${cap}): ${ctx.failure.message}`);
    appendStatusEvent(
      'progress',
      `Escalating to ${fallbackName.charAt(0).toUpperCase()}${fallbackName.slice(1)}…`,
    );
    return await ctx.retryWith(fallback, fallbackName);
  });

  log(`armed: fallback=${fallbackName}, cap=${cap} consecutive`);
}
