'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { SidebarProvider, SidebarTrigger } from '@ui/src';
import StickyBanner from './sticky-banner';
import UIHydrationComponent from '@/shared-components/ui-hydration-component';
import CustomSidebar from '@/features/sidebar/components/sidebar';
import useVoice2RxStore from '@/store/store';
import { tracker } from '@/analytics';
import { useBeforeUnload } from '@/features/session/hooks/use-before-unload';
import { useKeyboardShortcuts } from '@/features/session/hooks/use-keyboard-shortcuts';
import { useHostRecordingBridge } from '@/features/session/hooks/recording/use-host-recording-bridge';
import { useSidebarDrag } from '@/shared-hooks/use-sidebar-drag';
import { initEkaScribe, EKA_SCRIBE_DEFAULT_CONFIG } from '@/features/session/services/sdk-provider';
import { getStorage, getHost } from '@/platform';
import { MIXPANEL_EVENT_NAME } from '@/constants/enums';

initEkaScribe(EKA_SCRIBE_DEFAULT_CONFIG);

const noSidebarRoutes = ['/ekascribe', '/auth', '/logged-out', '/download', '/tutorial'];

const ScreenContainer = ({ children }: { children: React.ReactNode }) => {
  useBeforeUnload();
  useKeyboardShortcuts();
  useHostRecordingBridge();

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { sidebarWidth, onHandleMouseDown } = useSidebarDrag();

  // Single global gate: hold the hydration screen until the client has mounted and the
  // store has rehydrated, then reveal the shell + content in one shot.
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    if (useVoice2RxStore.persist.hasHydrated()) {
      setIsReady(true);
    } else {
      const unsubscribe = useVoice2RxStore.persist.onFinishHydration(() => setIsReady(true));
      return unsubscribe;
    }
  }, []);

  // Track desktop install once.
  useEffect(() => {
    if (getHost() !== 'desktop') return;
    if (getStorage().local.get('eka_install_tracked')) return;
    tracker.track({ name: MIXPANEL_EVENT_NAME.SCRIBEWEB_DESKTOP_INSTALL });
    getStorage().local.set('eka_install_tracked', '1');
  }, []);

  // Persist modal intent so it survives redirects through routes without the sidebar.
  useEffect(() => {
    const modal = searchParams.get('modal');
    if (modal) getStorage().session.set('ekascribe:pending-modal', modal);
  }, [searchParams]);

  if (!isReady) return <UIHydrationComponent />;

  const shouldShowSidebar = !noSidebarRoutes.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  );

  const body = shouldShowSidebar ? (
    <SidebarProvider
      className="flex-1 min-h-0!"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <header className="fixed top-0 left-0 right-0 z-50 h-14 flex items-center space-x-1 px-2 bg-background border-b border-border md:hidden">
        <SidebarTrigger className="cursor-pointer" />
        <div className="flex items-center gap-2 pl-1">
          <img src="/assets/vaarta-icon.svg" alt="vaarta" className="w-8 h-8" />
          <div className="flex flex-col justify-center">
            <span className="text-lg font-bold tracking-tight text-[#1A1A1A] leading-5">
              vaarta
            </span>
            <span className="text-[9px] italic font-medium tracking-wide text-[#767676] leading-3">
              powered by @eka.care
            </span>
          </div>
        </div>
      </header>

      <div className="flex w-full h-full pt-14 md:pt-0">
        <CustomSidebar />

        {/* Drag handle — sits at the right edge of the sidebar gap */}
        <div
          onMouseDown={onHandleMouseDown}
          className="hidden md:block relative z-20 w-0 cursor-col-resize group shrink-0"
        >
          <div className="absolute inset-y-0 -translate-x-1/2 w-[3px] rounded-full bg-transparent group-hover:bg-primary/30 transition-colors duration-150" />
        </div>

        <main className="flex-1 bg-secondary h-full w-full overflow-y-auto">{children}</main>
      </div>
    </SidebarProvider>
  ) : (
    <div className="flex flex-1 min-h-0 w-full bg-background overflow-y-auto">{children}</div>
  );

  return (
    <div className="h-dvh w-screen flex flex-col overflow-hidden">
      <StickyBanner />
      {body}
    </div>
  );
};

export default ScreenContainer;
