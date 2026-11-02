/**
 * Folio opened from a Folio Sign signing link (/s/<token>): the app shows
 * just that document, for that signer to sign.
 */
export const LINK_TOKEN: string | null =
  typeof location !== 'undefined' ? (/^\/s\/([\w-]{20,})\/?$/.exec(location.pathname)?.[1] ?? null) : null;
