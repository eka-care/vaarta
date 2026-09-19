'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { getStorage } from '@/platform';
import useVoice2RxStore from '@/store/store';
import { useAppMode } from '@/config/app-branding';

const DESKTOP_APP_POPUP_DISMISSED_KEY = 'ekascribe:desktop-app-popup-dismissed';

const isDismissedInThisTab = () =>
  getStorage().session.get(DESKTOP_APP_POPUP_DISMISSED_KEY) === 'true';

export const useDesktopAppPopup = (
  popupRef: RefObject<HTMLElement | null>,
  { enabled = false }: { enabled?: boolean } = {}
) => {
  const isLoggedIn = useVoice2RxStore((state) => !!state.loggedInUserDetails);
  const [isDismissed, setIsDismissed] = useState(isDismissedInThisTab);
  // Medical deployments don't promote the desktop app.
  const isMedicalMode = useAppMode() === 'medical';
  const isOpen = enabled && isLoggedIn && !isDismissed && !isMedicalMode;

  const dismiss = useCallback(() => {
    getStorage().session.set(DESKTOP_APP_POPUP_DISMISSED_KEY, 'true');
    setIsDismissed(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(event.target as Node)) {
        dismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, dismiss, popupRef]);

  return { isOpen, dismiss };
};
