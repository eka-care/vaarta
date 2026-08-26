'use client';

import { useCallback } from 'react';
import { getPlatform } from '@/platform';
import useVoice2RxStore from '@/store/store';
import { TUTORIAL_ROUTE } from '@/constants/tutorial';

export function useTutorialVideo() {
  const isCardDismissed = useVoice2RxStore((state) => state.tutorialCardDismissed);
  const isHintPending = useVoice2RxStore((state) => state.tutorialHintPending);
  const dismissCard = useVoice2RxStore((state) => state.dismissTutorialCard);
  const acknowledgeHint = useVoice2RxStore((state) => state.acknowledgeTutorialHint);

  const openTutorial = useCallback(() => {
    getPlatform().system?.openExternal(`${window.location.origin}${TUTORIAL_ROUTE}`);
  }, []);

  return {
    showCard: !isCardDismissed,
    showHint: isHintPending,
    openTutorial,
    dismissCard,
    acknowledgeHint,
  };
}
