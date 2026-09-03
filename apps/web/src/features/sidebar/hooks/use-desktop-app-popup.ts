'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { getStorage } from '@/platform';
import useVoice2RxStore from '@/store/store';

// sessionStorage is per browser tab, so each tab tracks its own dismissal and it survives refreshes.
const DESKTOP_APP_POPUP_DISMISSED_KEY = 'ekascribe:desktop-app-popup-dismissed';

// Reads the tab-scoped dismissal flag once, so the popup never flashes before the first render.
const isDismissedInThisTab = () =>
  getStorage().session.get(DESKTOP_APP_POPUP_DISMISSED_KEY) === 'true';

// Owns the post-login desktop-app popup for this tab: opt-in via `enabled`, hidden once dismissed (close, outside click, Escape).
export const useDesktopAppPopup = (
  popupRef: RefObject<HTMLElement | null>,
  { enabled = false }: { enabled?: boolean } = {}
) => {
  const isLoggedIn = useVoice2RxStore((state) => !!state.loggedInUserDetails);
  const [isDismissed, setIsDismissed] = useState(isDismissedInThisTab);
  const isOpen = enabled && isLoggedIn && !isDismissed;

  // Persist the dismissal for this tab only and hide the popup.
  const dismiss = useCallback(() => {
    getStorage().session.set(DESKTOP_APP_POPUP_DISMISSED_KEY, 'true');
    setIsDismissed(true);
  }, []);

  // Any click outside the popup (other sidebar buttons, navigation, page actions) closes it; redirects don't.
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
