import type { PartnerPublishedDocument } from '../types';

/**
 * Builds the post-publish redirect: session id + each document's presigned url as
 * query params, keeping the partner's own. http(s) only — this goes to window.open.
 */
export function buildPartnerCallbackUrl(
  rawCallbackUrl: string,
  sessionId: string,
  documents: PartnerPublishedDocument[]
): string | null {
  let url: URL;
  try {
    url = new URL(rawCallbackUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  url.searchParams.set('session_id', sessionId);
  // Appended as pairs so the nth doc_url and nth document_id always line up;
  // a document without a url is skipped entirely rather than shifting the rest.
  documents.forEach((doc) => {
    if (!doc.presigned_url) return;
    url.searchParams.append('doc_url', doc.presigned_url);
    url.searchParams.append('document_id', doc.document_id ?? '');
  });
  return url.toString();
}

/** The partner's redirect target for this session, if they set one. */
export function getPartnerCallbackUrl(additionalData?: Record<string, unknown>): string | null {
  const value = additionalData?.callback_url;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
