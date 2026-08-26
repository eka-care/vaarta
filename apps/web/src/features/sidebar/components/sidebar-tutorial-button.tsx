'use client';

import { useCallback } from 'react';
import { Play } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@ui/src';

import {
  CustomTooltip,
  CustomTooltipContent,
  CustomTooltipTrigger,
} from '@/shared-components/custom-tooltip';
import { tracker } from '@/analytics';
import { MIXPANEL_EVENT_NAME, MIXPANEL_EVENT_TYPE } from '@/constants/enums';
import { useTutorialVideo } from '@/shared-hooks/use-tutorial-video';

const SidebarTutorialButton = () => {
  const { showHint, openTutorial, acknowledgeHint } = useTutorialVideo();

  const handleClick = useCallback(() => {
    tracker.track({
      name: MIXPANEL_EVENT_NAME.SCRIBEWEB_SIDEBAR_CLICKS,
      type: MIXPANEL_EVENT_TYPE.WATCH_TUTORIAL,
    });
    openTutorial();
    acknowledgeHint();
  }, [openTutorial, acknowledgeHint]);

  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Watch tutorial"
      className={`size-9 cursor-pointer rounded-lg ${
        showHint
          ? 'text-primary bg-[#E9EFFF] hover:bg-[#E9EFFF] border border-primary'
          : 'text-[#1A1A1A] hover:bg-[#F3F4F6]'
      }`}
      onClick={handleClick}
    >
      <Play className="size-5" strokeWidth={1.5} />
    </Button>
  );

  // The hint replaces the hover tooltip until acknowledged, so only one ever renders.
  if (showHint) {
    return (
      <Popover open>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={8}
          className="flex w-49 flex-col justify-center gap-3 rounded-lg border-border p-4 shadow-md"
          // "Got it" is the only way out — outside clicks and Escape must not dismiss it.
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col items-start gap-1 text-foreground">
            <p className="whitespace-nowrap text-base font-medium leading-6">Need help later?</p>
            <p className="text-xs font-normal leading-4">
              You can watch the tutorial from here whenever you like.
            </p>
          </div>
          <div className="flex w-full flex-col items-end justify-center">
            <Button
              className="h-7 min-w-16 rounded-lg px-2 py-1.5 text-xs font-medium leading-4"
              onClick={acknowledgeHint}
            >
              Got it
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <CustomTooltip>
      <CustomTooltipTrigger asChild>{trigger}</CustomTooltipTrigger>
      <CustomTooltipContent collisionPadding={8}>Watch tutorial</CustomTooltipContent>
    </CustomTooltip>
  );
};

export default SidebarTutorialButton;
