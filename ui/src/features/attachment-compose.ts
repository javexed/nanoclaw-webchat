// The one thing a rendered HTML attachment may say to the app: "put this text
// in the composer". The page runs in an opaque-origin sandbox, so event.origin
// is always "null" and proves nothing; the message is trusted only when its
// source is the drawer's own frame AND it carries the nonce this open put in
// the frame URL's fragment. The frame keeps its window when the page navigates
// itself, so the source check alone would also hear whatever it navigated to;
// that document never saw the fragment. Even then a message can only PRE-FILL —
// sending stays a person pressing send.

export const COMPOSE_MESSAGE_TYPE = 'nanoclaw:compose';
/** Longest text a page may put in the composer; anything past it is cut. */
export const COMPOSE_MAX = 4000;

/** A fresh nonce for one open of a page: 128 random bits as hex. */
export function newComposeNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Control characters out, except newline and tab; CRLF/CR become LF. Also the
 * bidirectional overrides and isolates, which can make text read differently
 * from what will be sent.
 */
export function cleanComposeText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
  );
}

/**
 * The text a message asks to pre-fill, or null when the message is not one to
 * act on: from anywhere but `frame` (the drawer's iframe window), without this
 * open's `nonce`, or not exactly `{ type: 'nanoclaw:compose', text: string,
 * nonce: string }`.
 */
export function composeTextFrom(
  event: { source: unknown; data: unknown },
  frame: unknown,
  nonce: string,
): string | null {
  if (!frame || event.source !== frame || !nonce) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const keys = Object.keys(data).sort();
  if (keys.length !== 3 || keys[0] !== 'nonce' || keys[1] !== 'text' || keys[2] !== 'type') return null;
  const { type, text, nonce: got } = data as { type: unknown; text: unknown; nonce: unknown };
  if (type !== COMPOSE_MESSAGE_TYPE || typeof text !== 'string' || got !== nonce) return null;
  const clean = cleanComposeText(text).slice(0, COMPOSE_MAX);
  return clean.trim() ? clean : null;
}
