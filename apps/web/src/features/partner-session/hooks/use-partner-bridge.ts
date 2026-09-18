'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

import useVoice2RxStore from '@/store/store';
import { useSessionLifecycle } from '@/features/session/hooks/use-session-lifecycle';
import {
  notifyPartnerStatus,
  setPartnerCommandHandlers,
  startPartnerChannel,
} from '../handoff-channel';
import { getPartnerContext } from '../utils/partner-context';

// Mount once above the auth guard so the channel answers on the login screen too.
export function usePartnerBridge() {
  const router = useRouter();
  const { createSession } = useSessionLifecycle();

  const createSessionRef = useRef(createSession);
  createSessionRef.current = createSession;

  useEffect(() => {
    setPartnerCommandHandlers({
      // The channel already ran its phase guard, so replace a pristine idle session.
      createSession: (args) => createSessionRef.current({ ...args, force: true }),
      goToNewSession: () => router.push('/new-session'),
    });

    const stopChannel = startPartnerChannel();

    return () => {
      stopChannel();
      setPartnerCommandHandlers(null);
    };
  }, [router]);

  // Primitive selectors only — an object would fail Object.is every time.
  const sessionId = useVoice2RxStore((s) => s.sessionV2Ongoing.recording_session_id);
  const phase = useVoice2RxStore((s) => {
    const id = s.sessionV2Ongoing.recording_session_id;
    return id ? s.sessionV2ContentById[id]?.phase : undefined;
  });
  const isPartnerSession = useVoice2RxStore((s) => {
    const id = s.sessionV2Ongoing.recording_session_id;
    return id ? Boolean(getPartnerContext(s.sessionV2ContentById[id])) : false;
  });

  useEffect(() => {
    if (!sessionId || !phase || !isPartnerSession) return;
    notifyPartnerStatus(sessionId, phase);
  }, [sessionId, phase, isPartnerSession]);
}
