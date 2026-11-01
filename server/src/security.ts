/**
 * RFC 9116 security.txt. Contact and expiry are configuration, not copy-paste
 * text, so a production check can require a real mailbox.
 */
export function securityTxt(
  publicBaseUrl: string,
  contact: string | undefined,
  expires: string,
): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const parsed = Date.parse(expires);
  const expiresAt = Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const safeContact = (contact ?? 'mailto:security@boorushiko.example').replace(/[\r\n]+/g, ' ');

  return [
    `Contact: ${safeContact}`,
    `Expires: ${expiresAt}`,
    'Preferred-Languages: en, ru',
    `Canonical: ${base}/.well-known/security.txt`,
    `Policy: ${base}/rules`,
    '',
  ].join('\n');
}
