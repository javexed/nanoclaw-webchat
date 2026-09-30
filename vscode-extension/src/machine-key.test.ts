import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MACHINE_KEY_SECRET, loadOrCreateMachineKey, type SecretStore } from './machine-key.js';
import { machineKeyMessage } from './protocol.js';

function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get: async (k) => data[k],
    store: async (k, v) => {
      data[k] = v;
    },
  };
}
const pub = (b64: string) => createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });

describe('machine key', () => {
  it('is generated once, kept in secret storage, and the same key comes back', async () => {
    const store = memoryStore();
    const a = await loadOrCreateMachineKey(store);
    expect(store.data[MACHINE_KEY_SECRET]).toBeTruthy();
    expect(pub(a.publicKey).asymmetricKeyType).toBe('ed25519');
    const b = await loadOrCreateMachineKey(store);
    expect(b.publicKey).toBe(a.publicKey);
  });

  it('signs the challenge bound to fingerprint and origin; the signature does not fit another', async () => {
    const k = await loadOrCreateMachineKey(memoryStore());
    const sig = Buffer.from(k.signChallenge('fp', 'https://central.example', 'n1'), 'base64');
    const ok = (fp: string, origin: string, nonce: string) =>
      verify(null, Buffer.from(machineKeyMessage(fp, origin, nonce)), pub(k.publicKey), sig);
    expect(ok('fp', 'https://central.example', 'n1')).toBe(true);
    expect(ok('fp', 'https://central.example', 'n2')).toBe(false); // replay for another challenge
    expect(ok('fp', 'https://elsewhere.example', 'n1')).toBe(false); // relayed through another server
    expect(ok('fp2', 'https://central.example', 'n1')).toBe(false);
  });

  it('replaces a stored value that is not a key', async () => {
    const store = memoryStore({ [MACHINE_KEY_SECRET]: 'garbage' });
    const k = await loadOrCreateMachineKey(store);
    expect(store.data[MACHINE_KEY_SECRET]).not.toBe('garbage');
    expect(pub(k.publicKey).asymmetricKeyType).toBe('ed25519');
  });
});
