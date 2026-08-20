/**
 * Wizard / Settings preflight self-test.
 *
 * A recurring failure class in setup is a capability that IS present being
 * reported as absent, because the check had a hidden precondition that isn't
 * true at first-run time:
 *   - validated from the host when the consumer is a container (wrong vantage)
 *   - gated behind the very setting it's meant to help you enable
 *   - not checked at all (host firewall silently dropping docker→host)
 *
 * This runs each check UNCONDITIONALLY and from the vantage point that actually
 * matters, and returns an actionable verdict + copy-paste fix — so the operator
 * sees the truth at setup time instead of debugging silent failures later.
 */
import { execFile } from 'node:child_process';

import { getAuthManagementInfo, probeTailscaleHealth } from './auth.js';
import { log } from '../../log.js';

export type PreflightStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface PreflightCheck {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  /** Copy-paste remediation, when there is one. */
  fix?: string;
}

const DOCKER_BRIDGE_CIDR = '172.17.0.0/16';
const OLLAMA_PORT = 11434;

function run(cmd: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; code?: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '', code: (err as NodeJS.ErrnoException | null)?.code });
    });
  });
}

async function checkTailscale(): Promise<PreflightCheck> {
  await probeTailscaleHealth(); // force a fresh probe (unconditional)
  const ts = (await getAuthManagementInfo()).tailscale;
  if (ts.healthy) {
    return {
      id: 'tailscale',
      label: 'Tailscale',
      status: 'ok',
      detail: ts.enabled
        ? 'A tailnet is up on this host and enabled for sign-in.'
        : 'A tailnet is up on this host — you can enable tailnet sign-in in the access step.',
    };
  }
  return {
    id: 'tailscale',
    label: 'Tailscale',
    status: 'info',
    detail: 'No tailnet detected on this host.',
    fix: 'To use tailnet sign-in, install Tailscale and run:\n  sudo tailscale up\nthen re-run this check.',
  };
}

async function checkDocker(): Promise<PreflightCheck> {
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}'], 5000);
  if (r.ok) {
    return {
      id: 'docker',
      label: 'Docker',
      status: 'ok',
      detail: `Docker engine reachable (server ${r.stdout.trim()}).`,
    };
  }
  return {
    id: 'docker',
    label: 'Docker',
    status: 'fail',
    detail:
      r.code === 'ENOENT'
        ? 'The docker CLI is not on PATH for the server process.'
        : 'The docker engine is not reachable (daemon down, or the service user lacks access).',
    fix: 'Agent containers need Docker. Install it, ensure the daemon is running, and that this user can run `docker` (e.g. is in the docker group).',
  };
}

/**
 * Firewall/vantage canary: if a local Ollama is up on the host, verify an agent
 * CONTAINER can reach it — the exact path a default-deny host firewall silently
 * drops. Uses Ollama as the probe target because it's the common local-AI case;
 * skips cleanly when there's no local Ollama to canary against.
 */
async function checkContainerToHost(): Promise<PreflightCheck> {
  const id = 'container-networking';
  const label = 'Agent container → host';

  // Is a local Ollama up on the host? (host-side, quick)
  let hostOllamaUp = false;
  try {
    const res = await fetch(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, { signal: AbortSignal.timeout(3000) });
    hostOllamaUp = res.ok;
  } catch {
    hostOllamaUp = false;
  }
  if (!hostOllamaUp) {
    return {
      id,
      label,
      status: 'info',
      detail:
        'No local Ollama to canary with — skipped. Per-model reachability is checked on each model (Test reachability).',
    };
  }

  const image = await resolveAgentImage();
  if (!image) {
    return { id, label, status: 'info', detail: 'Agent image not built yet — can’t run the container probe.' };
  }

  // TCP-connect from inside a throwaway agent container to the host bridge IP.
  const script =
    `const net=require('net');const s=net.connect(${OLLAMA_PORT},'host.docker.internal');` +
    `s.setTimeout(4000);` +
    `s.on('connect',()=>{console.log('ok');process.exit(0)});` +
    `s.on('timeout',()=>{console.log('timeout');process.exit(0)});` +
    `s.on('error',e=>{console.log('error:'+(e.code||e.message));process.exit(0)});`;
  const r = await run(
    'docker',
    ['run', '--rm', '--add-host=host.docker.internal:host-gateway', '--entrypoint', 'bun', image, '-e', script],
    20000,
  );
  const out = (r.stdout || '').trim().split('\n').pop() || '';

  if (out === 'ok') {
    return {
      id,
      label,
      status: 'ok',
      detail: `An agent container can reach host services (verified against Ollama on :${OLLAMA_PORT}).`,
    };
  }
  if (out === 'timeout') {
    return {
      id,
      label,
      status: 'fail',
      detail: `The host reaches Ollama on :${OLLAMA_PORT}, but an agent container's connection times out — the host firewall is dropping Docker-bridge → host traffic.`,
      fix:
        `Allow the Docker bridge to reach host services. If you use UFW:\n` +
        `  sudo ufw allow from ${DOCKER_BRIDGE_CIDR} to any port ${OLLAMA_PORT} proto tcp\n` +
        `For firewalld:\n  sudo firewall-cmd --permanent --zone=trusted --add-source=${DOCKER_BRIDGE_CIDR} && sudo firewall-cmd --reload`,
    };
  }
  if (out.startsWith('error:ECONNREFUSED')) {
    return {
      id,
      label,
      status: 'warn',
      detail: `A container reached the host but Ollama refused on :${OLLAMA_PORT} — it may be bound to 127.0.0.1 only.`,
      fix: `Bind Ollama to all interfaces:\n  OLLAMA_HOST=0.0.0.0:${OLLAMA_PORT} (systemd override) then restart ollama.`,
    };
  }
  log.info('Webchat preflight: container→host probe inconclusive', { out });
  return { id, label, status: 'info', detail: `Container probe was inconclusive (${out || 'no output'}).` };
}

function resolveAgentImage(): Promise<string | null> {
  const fromEnv = process.env.CONTAINER_IMAGE || process.env.AGENT_IMAGE;
  if (fromEnv && fromEnv.trim()) return Promise.resolve(fromEnv.trim());
  return run('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], 5000).then((r) => {
    if (!r.ok) return null;
    return (
      r.stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('nanoclaw-agent')) ?? null
    );
  });
}

/** Run all preflight checks. Never throws — a failed check degrades to `info`. */
export async function runPreflight(): Promise<PreflightCheck[]> {
  const checks = [checkTailscale(), checkDocker(), checkContainerToHost()];
  const settled = await Promise.allSettled(checks);
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { id: `check-${i}`, label: 'Check', status: 'info' as PreflightStatus, detail: 'This check could not run.' },
  );
}
