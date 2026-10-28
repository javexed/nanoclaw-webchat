/**
 * Registrable domains ("eTLD+1"), for one question: does the app domain share
 * a site with NanoClaw's own address? Browsers treat two names under the same
 * registrable domain as one site (cookies, SameSite), so an app there could
 * set cookies NanoClaw reads or ride its sessions.
 *
 * There is no Public Suffix List library in this tree, and one is not added
 * for this (new npm packages wait out the release-age rule). This is a
 * minimal stand-in: the multi-label public suffixes people actually register
 * under (co.uk, com.au, …) and the hosting suffixes an app domain could
 * plausibly sit on. Where it does not know a multi-label suffix, names under
 * that suffix look like one site to it, so it refuses more than the real list
 * would. It can refuse less in one case: a country code where `co.`, `com.`
 * and the like are ordinary registered names rather than suffixes. The full
 * list: https://publicsuffix.org/list/.
 */

/** Second-level labels used as public suffixes under many country codes. */
const CC_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'ne', 'or', 'go', 'gob', 'mil']);

/** Known two-or-more-label public suffixes (ICANN section and common private ones). */
const MULTI_LABEL_SUFFIXES = new Set([
  'ltd.uk',
  'plc.uk',
  'me.uk',
  'sch.uk',
  'nhs.uk',
  'police.uk',
  'id.au',
  'asn.au',
  'qc.ca',
  'on.ca',
  'bc.ca',
  'ab.ca',
  'gc.ca',
  'priv.no',
  'blogspot.com',
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'netlify.app',
  'vercel.app',
  'herokuapp.com',
  'azurewebsites.net',
  'cloudapp.net',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'fly.dev',
  'onrender.com',
  'ts.net',
  'trycloudflare.com',
  'cloudflareaccess.com',
  'duckdns.org',
  'no-ip.org',
  'ddns.net',
  'dyndns.org',
  's3.amazonaws.com',
]);

/** Lowercased, without a trailing dot or port; '' when it is not a DNS name. */
export function normalizeHost(h: string): string {
  const v = h.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  // A name, not an address: the last label is never all digits.
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v) &&
    !/\.\d+$/.test(v)
    ? v
    : '';
}

/** The public suffix a name sits under, as far as this list knows. */
export function publicSuffix(host: string): string {
  const labels = normalizeHost(host).split('.');
  if (labels.length < 2) return labels[0] ?? '';
  // The longest known multi-label suffix wins.
  for (let i = 0; i < labels.length - 1; i++) {
    const cand = labels.slice(i).join('.');
    if (MULTI_LABEL_SUFFIXES.has(cand)) return cand;
  }
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  if (tld.length === 2 && CC_SECOND_LEVEL.has(sld)) return `${sld}.${tld}`;
  return tld;
}

/** The registrable domain (suffix plus one label), or '' for a bare suffix or a non-name. */
export function registrableDomain(host: string): string {
  const h = normalizeHost(host);
  if (!h) return '';
  const suffix = publicSuffix(h);
  if (h === suffix) return '';
  const rest = h.slice(0, -(suffix.length + 1)).split('.');
  return `${rest[rest.length - 1]}.${suffix}`;
}

/** Do the two names share a registrable domain (one site, as browsers see it)? */
export function sameSite(a: string, b: string): boolean {
  const ra = registrableDomain(a);
  return ra !== '' && ra === registrableDomain(b);
}
