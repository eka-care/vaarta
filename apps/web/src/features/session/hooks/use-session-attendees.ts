'use client';

import { useCallback } from 'react';
import useVoice2RxStore from '@/store/store';
import { with401Retry } from '@/fetch-client/api-with-retry';
import { getSDK } from '@/features/session/services/sdk-provider';
import { tracker } from '@/analytics';

/**
 * Attendees live in `additional_data.attendees`, the same key a partner sends them
 * under. The PATCH replaces additional_data wholesale, so merge before sending.
 */
export const useSessionAttendees = (sessionId: string) => {
  const attendees = useVoice2RxStore(
    (s) => (s.sessionV2ContentById[sessionId]?.additional_data?.attendees as string | undefined) ?? ''
  );

  const saveAttendees = useCallback(
    async (next: string) => {
      const store = useVoice2RxStore.getState();
      const current = store.sessionV2ContentById[sessionId]?.additional_data ?? {};
      const trimmed = next.trim();

      const merged: Record<string, unknown> = { ...current };
      if (trimmed) {
        merged.attendees = trimmed;
      } else {
        delete merged.attendees;
      }

      // Optimistic; reverted below if the API rejects it.
      store.setSessionV2Content(sessionId, { additional_data: merged });

      try {
        const response = await with401Retry(
          () => getSDK().sessions.patchSessionStatus({ additional_data: merged }, sessionId),
          'patch session attendees'
        );
        if (!response.success) {
          useVoice2RxStore.getState().setSessionV2Content(sessionId, { additional_data: current });
          useVoice2RxStore.getState().setWarningInfo({
            message: 'Failed to save attendees. Please try again.',
            type: 'error',
            screen: 'start_session',
          });
        }
      } catch (err) {
        useVoice2RxStore.getState().setSessionV2Content(sessionId, { additional_data: current });
        tracker.error(err, {
          domain: 'api',
          component: 'voice_api',
          extra: { action: 'save_session_attendees', session_id: sessionId },
        });
        useVoice2RxStore.getState().setWarningInfo({
          message: 'Failed to save attendees. Please try again.',
          type: 'error',
          screen: 'start_session',
        });
      }
    },
    [sessionId]
  );

  const removeAttendees = useCallback(() => saveAttendees(''), [saveAttendees]);

  return { attendees, saveAttendees, removeAttendees };
};
