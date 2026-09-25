// ── .env writer ──────────────────────────────────────────────────────────────
// One place the webchat module writes install env from. Lives on its own so
// both the Ollama console and the model registry can use it without importing
// each other (ollama-manage imports models; models must not import it back).
import fs from 'fs';
import path from 'path';

/** Idempotent KEY=VALUE upsert into .env (mirrors the installers' set_env). */
export function upsertEnv(root: string, key: string, val: string): void {
  const envFile = path.join(root, '.env');
  // Strip CR/LF so a value can never inject an extra KEY=value line (e.g. a
  // crafted ElevenLabs key rebinding WEBCHAT_HOST). Keys here are constants.
  const safeVal = String(val).replace(/[\r\n]/g, '');
  let raw = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  raw = raw
    .split('\n')
    .filter((l) => !l.startsWith(`${key}=`))
    .join('\n');
  if (raw && !raw.endsWith('\n')) raw += '\n';
  fs.writeFileSync(envFile, raw + `${key}=${safeVal}\n`, { mode: 0o600 });
  // mode only applies on create; force 0600 on the (usual) pre-existing file so
  // WEBCHAT_STT_API_KEY never lands in a group/world-readable .env.
  try {
    fs.chmodSync(envFile, 0o600);
  } catch {
    /* best-effort; non-fatal on platforms without chmod semantics */
  }
}

/** Remove KEY from .env (no-op when absent). */
export function removeEnv(root: string, key: string): void {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return;
  const raw = fs.readFileSync(envFile, 'utf8');
  const next = raw
    .split('\n')
    .filter((l) => !l.startsWith(`${key}=`))
    .join('\n');
  if (next !== raw) fs.writeFileSync(envFile, next, { mode: 0o600 });
}
