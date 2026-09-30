// This machine's Ed25519 key: proof that a connection comes from the machine
// central paired, not from something that learned its fingerprint. Generated on
// first run; the private half lives in VS Code's secret storage and never
// leaves it. Pure but for the injected store, so it is unit-testable.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { machineKeyMessage } from './protocol.js';

/** The subset of vscode.SecretStorage used here. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}
export interface MachineKey {
  /** SPKI DER, base64 — what the hello carries and central binds. */
  publicKey: string;
  /** Sign central's challenge for this fingerprint, as addressed to `origin`. */
  signChallenge(fingerprint: string, origin: string, nonce: string): string;
}

export const MACHINE_KEY_SECRET = 'nanoclaw.machineKey';

function fromPrivate(privateKey: KeyObject): MachineKey {
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    publicKey,
    signChallenge: (fingerprint, origin, nonce) =>
      sign(null, Buffer.from(machineKeyMessage(fingerprint, origin, nonce)), privateKey).toString('base64'),
  };
}

/** The stored key, or a new one stored now. A stored value that is not an Ed25519 key is replaced. */
export async function loadOrCreateMachineKey(secrets: SecretStore): Promise<MachineKey> {
  const saved = await secrets.get(MACHINE_KEY_SECRET);
  if (saved) {
    try {
      const k = createPrivateKey({ key: Buffer.from(saved, 'base64'), format: 'der', type: 'pkcs8' });
      if (k.asymmetricKeyType === 'ed25519') return fromPrivate(k);
    } catch {
      /* unreadable: replaced below */
    }
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  await secrets.store(MACHINE_KEY_SECRET, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
  return fromPrivate(privateKey);
}
