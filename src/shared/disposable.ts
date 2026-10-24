/** Throw-away inbox services: an address there cannot back a free plan (a new one costs nothing to make). */
export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com", "mailinator.net", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "sharklasers.com",
  "grr.la", "10minutemail.com", "10minutemail.net", "temp-mail.org", "temp-mail.io", "tempmail.com", "tempmail.net", "tempmailo.com", "tempmail.plus",
  "tempr.email", "throwawaymail.com", "yopmail.com", "yopmail.net", "yopmail.fr", "trashmail.com", "trashmail.de", "getnada.com", "nada.email",
  "dispostable.com", "maildrop.cc", "mailnesia.com", "mintemail.com", "mohmal.com", "emailondeck.com", "fakeinbox.com", "spamgourmet.com",
  "mailcatch.com", "moakt.com", "burnermail.io", "1secmail.com", "1secmail.net", "1secmail.org", "dropmail.me", "emailfake.com", "fakemail.net",
  "inboxkitten.com", "mail.tm", "mailpoof.com", "tmail.ws", "tmpmail.org", "tmpmail.net", "minuteinbox.com", "spambox.us", "mytemp.email",
]);

export function isDisposableEmail(email: string | null | undefined): boolean {
  const domain = (email ?? "").split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  // Sub-domains of a listed service count too (e.g. x.mailinator.com).
  return [...DISPOSABLE_EMAIL_DOMAINS].some((d) => domain === d || domain.endsWith(`.${d}`));
}
