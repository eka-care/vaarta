'use client';

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import { with401Retry } from '@/fetch-client/api-with-retry';
import { getSDK } from '@/features/session/services/sdk-provider';
import useVoice2RxStore from '@/store/store';
import { isPartnerConnected, publishToPartner } from '../handoff-channel';
import { buildPartnerPublishPayload } from '../utils/build-publish-payload';
import { buildPartnerCallbackUrl, getPartnerCallbackUrl } from '../utils/build-callback-url';
import { getPartnerContext } from '../utils/partner-context';

// The session PATCH replaces additional_data wholesale, so merge rather than send alone.
function markPublished(sessionId: string) {
  const store = useVoice2RxStore.getState();
  const content = store.sessionV2ContentById[sessionId];
  const partnerContext = getPartnerContext(content);
  if (!partnerContext) return;

  const additionalData = {
    ...(content?.additional_data ?? {}),
    partner_context: { ...partnerContext, published_at: Date.now() },
  };

  store.setSessionV2Content(sessionId, { additional_data: additionalData });
  with401Retry(
    () => getSDK().sessions.patchSessionStatus({ additional_data: additionalData }, sessionId),
    'patch partner published'
  ).catch(() => {});
}

export function usePublishToPartner(sessionId: string) {
  const isPartnerSession = useVoice2RxStore((s) =>
    Boolean(getPartnerContext(s.sessionV2ContentById[sessionId]))
  );
  const publishedAt = useVoice2RxStore(
    (s) => getPartnerContext(s.sessionV2ContentById[sessionId])?.published_at ?? 0
  );
  // Lives in additional_data, so it survives a reload and is still there when an
  // older session is opened and published days later.
  const callbackUrl = useVoice2RxStore((s) =>
    getPartnerCallbackUrl(s.sessionV2ContentById[sessionId]?.additional_data)
  );

  const [isPublishing, setIsPublishing] = useState(false);
  // setState lands a render too late to stop a double click.
  const inFlightRef = useRef(false);

  const publish = useCallback(
    async (flushPendingEdits?: () => Promise<unknown>) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setIsPublishing(true);

      // Open the tab now, while the click still counts as a user gesture — a
      // window.open after the awaits below reads as programmatic and gets blocked.
      const redirectWindow = callbackUrl ? window.open('', '_blank') : null;
      let handedOff = false;

      try {
        await flushPendingEdits?.();
        const documents = await buildPartnerPublishPayload(sessionId);

        if (callbackUrl) {
          const target = buildPartnerCallbackUrl(callbackUrl, sessionId, documents);
          if (!target) {
            toast.error('The app that started this session gave an invalid callback URL.');
            return;
          }
          if (redirectWindow) {
            redirectWindow.location.href = target;
          } else if (!window.open(target, '_blank')) {
            // Both attempts blocked — say so instead of appearing to do nothing.
            toast.error('Allow pop-ups for this site to send the notes back.');
            return;
          }
          handedOff = true;
          markPublished(sessionId);
          toast.success('Notes published.');
          return;
        }

        // No callback url — fall back to the live postMessage channel.
        if (!isPartnerConnected()) {
          toast.error('Not connected to the app that started this session.');
          return;
        }
        if (!publishToPartner(sessionId, documents)) {
          toast.error('Could not send the notes back. Please try again.');
          return;
        }
        markPublished(sessionId);
        toast.success('Notes published.');
      } catch (error) {
        console.error('[partner-session] publish failed:', error);
        toast.error('Could not send the notes back. Please try again.');
      } finally {
        // Don't strand an empty tab if we never navigated it.
        if (redirectWindow && !handedOff) {
          try {
            redirectWindow.close();
          } catch {
            // already gone
          }
        }
        inFlightRef.current = false;
        setIsPublishing(false);
      }
    },
    [sessionId, callbackUrl]
  );

  return { isPartnerSession, isPublishing, publishedAt, publish, callbackUrl };
}
