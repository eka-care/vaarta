'use client';

import { useCallback } from 'react';
import { Play, X } from 'lucide-react';

import { TUTORIAL_CARD_THUMBNAIL_SRC } from '@/constants/tutorial';
import { MIXPANEL_EVENT_NAME, MIXPANEL_EVENT_TYPE } from '@/constants/enums';
import { tracker } from '@/analytics';
import { useTutorialVideo } from '@/shared-hooks/use-tutorial-video';

function TutorialVideoCard() {
  const { showCard, openTutorial, dismissCard } = useTutorialVideo();

  const handleWatch = useCallback(() => {
    tracker.track({
      name: MIXPANEL_EVENT_NAME.SCRIBEWEB_NEW_SESSION,
      type: MIXPANEL_EVENT_TYPE.WATCH_TUTORIAL,
    });
    openTutorial();
    dismissCard();
  }, [openTutorial, dismissCard]);

  if (!showCard) return null;

  return (
    <div className="relative mb-4 flex w-80.5 max-w-full flex-col overflow-hidden rounded-lg border border-border bg-background shadow-sm transition-colors hover:bg-accent">
      <button
        type="button"
        onClick={handleWatch}
        className="flex w-full cursor-pointer flex-col items-start text-left"
      >
        <div className="relative h-30 w-full overflow-hidden border-b border-border">
          <img
            src={TUTORIAL_CARD_THUMBNAIL_SRC}
            alt=""
            aria-hidden="true"
            className="absolute left-0 top-[-17.86%] h-[150%] w-full max-w-none"
          />
        </div>
        <div className="flex h-9 w-full flex-col items-start px-3 py-2">
          <div className="flex min-h-px w-full flex-1 items-center justify-center gap-1">
            <Play className="size-4 shrink-0 text-primary" fill="currentColor" />
            <span className="whitespace-nowrap text-sm font-medium leading-5 text-foreground">
              New to Vaarta? Watch a short tour.
            </span>
          </div>
        </div>
      </button>

      <button
        type="button"
        aria-label="Dismiss tutorial card"
        onClick={dismissCard}
        className="absolute right-2 top-2 flex size-4 cursor-pointer items-center justify-center opacity-50 hover:opacity-100"
      >
        <X className="size-4 text-[#999999]" />
      </button>
    </div>
  );
}

export default TutorialVideoCard;
