import { fetchGetUrl } from '@/features/session/services/document-service';
import useVoice2RxStore from '@/store/store';
import type { PartnerPublishedDocument } from '../types';

// Document info for the partner, never the content. Urls are minted fresh; cached ones expire.
export async function buildPartnerPublishPayload(
  sessionId: string
): Promise<PartnerPublishedDocument[]> {
  const documents =
    useVoice2RxStore.getState().sessionV2ContentById[sessionId]?.documents ?? [];

  return Promise.all(
    documents.map(async (doc) => ({
      document_id: doc.document_id,
      document_name: doc.document_name,
      template_id: doc.template_id,
      document_type: doc.document_type,
      type: doc.type,
      status: doc.status,
      errors: doc.errors,
      warnings: doc.warnings,
      presigned_url: await fetchGetUrl(sessionId, doc.document_id),
    }))
  );
}
