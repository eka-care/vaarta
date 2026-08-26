'use client';

import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Sidebar, SidebarFooter, SidebarHeader, Button, SidebarContent } from '@ui/src';

import {
  ChevronRight,
  ChevronLeft,
  Plus,
  LayoutTemplate,
  Settings,
  Download,
  LogOut,
  RefreshCw,
  Check,
  User,
} from 'lucide-react';
import SidebarPastSessions from './sidebar-past-sessions';
import SidebarSearchBar from './sidebar-search-bar';
import { VaartaLogoLottie } from '@/shared-components/vaarta-logo-lottie';
import { useRouter } from 'next/navigation';
import useVoice2RxStore from '@/store/store';
import { getPlatform, getStorage, useAppUpdates, WebOnly, DesktopOnly } from '@/platform';
import { useSidebar } from '@ui/src';
import { usePastSessionsHistory } from '@/features/sidebar/hooks/use-past-session-history';
import { useSessionLifecycle } from '@/features/session/hooks/use-session-lifecycle';
import { tracker } from '@/analytics';
import { MIXPANEL_EVENT_NAME, MIXPANEL_EVENT_TYPE } from '@/constants/enums';
import { handleUserLogout } from '@/utils/user-auth-logout-utility-methods';
import UserDefaultsDialog from '@/features/settings/components/user-defaults-dialog';
import { SESSION_PHASE } from '@/constants/enums';
import { useSessionFilterSort } from '@/features/sidebar/hooks/use-session-filter-sort';
import {
  CustomTooltip,
  CustomTooltipContent,
  CustomTooltipTrigger,
} from '@/shared-components/custom-tooltip';
import { SidebarBottomPanel, SidebarPanelItem } from './sidebar-bottom-panel';
import SidebarPromoBanner from './sidebar-promo-banner';
import SidebarTutorialButton from './sidebar-tutorial-button';

const CustomSidebar = () => {
  const {
    sessions,
    loading: sessionsLoadingState,
    loadingMore: sessionsLoadingMoreState,
    error: sessionsErrorState,
    hasNextPage,
    goToNextPage,
    searchQuery,
    setSearchQuery,
    isSearching,
    refreshSessions,
    removeSession,
  } = usePastSessionsHistory({
    initialBatchSize: 10,
    loadMoreBatchSize: 10,
    pageSize: 10,
  });

  const pathname = usePathname();
  const loggedInUserDetails = useVoice2RxStore((state) => state.loggedInUserDetails);
  const { state, setOpen } = useSidebar();
  const [permanentState, setPermanentState] = useState<'expanded' | 'collapsed'>(state);

  const v2SessionId = useVoice2RxStore((state) => state.sessionV2Ongoing.recording_session_id);
  const newSessionId = useVoice2RxStore((state) => state.newSessionId);
  const v2Phase = useVoice2RxStore(
    (state) => state.sessionV2ContentById[state.sessionV2Ongoing.recording_session_id]?.phase
  );
  const v2IsLimitExceeded = useVoice2RxStore(
    (state) =>
      state.sessionV2ContentById[state.sessionV2Ongoing.recording_session_id]?.is_limit_exceeded ??
      false
  );
  const { createSession } = useSessionLifecycle();
  // Two paths open this dialog:
  // 1. sessionStorage (set by SectionContainer when ?modal=user-defaults arrives)
  // 2. URL search param (handled in useEffect below)
  // Cleared ONLY when user dismisses the dialog (onOpenChange → false).
  const [isUserDefaultsOpen, setIsUserDefaultsOpen] = useState(() => {
    return getStorage().session.get('ekascribe:pending-modal') === 'user-defaults';
  });

  const [activePanel, setActivePanel] = useState<'profile' | null>(null);

  const appUpdates = useAppUpdates();
  const [updatePhase, setUpdatePhase] = useState<'available' | 'downloading' | 'ready' | null>(
    null
  );
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState(0);

  useEffect(() => {
    if (!appUpdates) return;
    const unsubAvail = appUpdates.onUpdateAvailable((info) => {
      setUpdateVersion(info.version);
      setUpdatePhase('available');
    });
    const unsubProg = appUpdates.onUpdateProgress((info) => {
      setUpdateProgress(info.percent);
      setUpdatePhase('downloading');
    });
    const unsubReady = appUpdates.onUpdateReady(() => setUpdatePhase('ready'));
    return () => {
      unsubAvail();
      unsubProg();
      unsubReady();
    };
  }, [appUpdates]);

  const footerRef = useRef<HTMLDivElement>(null);
  const searchParams = useSearchParams();

  useEffect(() => {
    const unsub = getPlatform().system?.onOpenUserDefaults?.(() => setIsUserDefaultsOpen(true));
    return () => unsub?.();
  }, []);

  useEffect(() => {
    const unsub = getPlatform().system?.onLogout?.(() => void handleUserLogout());
    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (!activePanel) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (footerRef.current && !footerRef.current.contains(e.target as Node)) {
        setActivePanel(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [activePanel]);

  useEffect(() => {
    const modal = searchParams.get('modal');
    if (!modal) return;

    if (modal === 'user-defaults') {
      setIsUserDefaultsOpen(true);
    }

    const params = new URLSearchParams(window.location.search);
    params.delete('modal');
    const newUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    window.history.replaceState(null, '', newUrl);
  }, [searchParams]);

  const [isRefreshingSessions, setIsRefreshingSessions] = useState(false);
  const router = useRouter();
  const [isStartingNewSession, setIsStartingNewSession] = useState(false);
  const isStartingNewSessionRef = useRef(false);

  const isSessionActive = v2Phase === SESSION_PHASE.RECORDING || v2Phase === SESSION_PHASE.PAUSED;

  // Broader check: session is still ongoing (recording, paused, or processing).
  // Excludes output/error because by then the API processing_status reflects the
  // final state and the stale recording_session_id
  // would cause click-redirect issues.
  const isPastSessionOngoing =
    v2Phase === SESSION_PHASE.RECORDING ||
    v2Phase === SESSION_PHASE.PAUSED ||
    v2Phase === SESSION_PHASE.PROCESSING;

  const handleCurrentSessionClick = useCallback(() => {
    if (!v2SessionId) return;

    // New session (idle/recording) → /new-session, past session → /session/{id}
    const targetPath =
      v2Phase === SESSION_PHASE.IDLE ||
      v2Phase === SESSION_PHASE.RECORDING ||
      v2Phase === SESSION_PHASE.PAUSED
        ? '/new-session'
        : `/session/${v2SessionId}`;

    if (pathname === targetPath) return;
    router.push(targetPath as any);
  }, [v2SessionId, v2Phase, pathname, router]);

  const handleNewSessionClick = async () => {
    // Block when a recording is active
    if (isSessionActive) return;

    // Guard against rapid double-clicks (ref is synchronous, unlike useState)
    if (isStartingNewSessionRef.current) return;

    isStartingNewSessionRef.current = true;
    setIsStartingNewSession(true);

    tracker.track({
      name: MIXPANEL_EVENT_NAME.SCRIBEWEB_SIDEBAR_CLICKS,
      type: MIXPANEL_EVENT_TYPE.NEW_SESSION,
    });

    // Refresh past sessions so the previous session appears in the list.
    await refreshSessions().catch(console.error);

    // Create up front so /new-session reuses it instead of opening the latest session.
    await createSession({ force: true });
    router.push('/new-session');

    isStartingNewSessionRef.current = false;
    setIsStartingNewSession(false);
  };

  // True when the ongoing V2 session is the one created via the new-session flow.
  // Past sessions being recorded/viewed are highlighted in the list instead.
  const isNewSession = !!v2SessionId && v2SessionId === newSessionId;

  // Ongoing session card in past sessions list.
  // Only shown for NEW sessions (not yet in past sessions list).
  const ongoingSessionData = useMemo(() => {
    if (!isNewSession || v2IsLimitExceeded) return null;

    // Map V2 phase to a status string compatible with getOngoingSessionStatus
    const phaseToStatus: Record<string, string> = {
      [SESSION_PHASE.IDLE]: 'initialized',
      [SESSION_PHASE.RECORDING]: 'recording',
      [SESSION_PHASE.PAUSED]: 'paused',
      [SESSION_PHASE.PROCESSING]: 'analysing',
      [SESSION_PHASE.OUTPUT]: 'success',
      [SESSION_PHASE.ERROR]: 'system_failure',
    };
    const displayStatus = phaseToStatus[v2Phase] || 'initialized';

    return {
      processingStatus: displayStatus,
    };
  }, [isNewSession, v2IsLimitExceeded, v2Phase]);

  const handleRefreshSessions = async () => {
    if (!isRefreshingSessions) {
      setIsRefreshingSessions(true);
      try {
        await refreshSessions();
      } finally {
        setIsRefreshingSessions(false);
      }
    }
  };

  const {
    filterGroupsWithCounts: sessionFilterGroups,
    filteredSessions,
    isFilterActive: isSessionFilterActive,
    sortOrder: sessionSortOrder,
    toggleFilterGroup: toggleSessionFilterGroup,
    clearFilters: clearSessionFilters,
    toggleSortOrder: toggleSessionSortOrder,
  } = useSessionFilterSort(sessions);

  // Exclude the ongoing session from the past sessions list so it doesn't
  // appear twice (once as "Current Session" and once in the date-grouped list).
  const displaySessions = useMemo(() => {
    if (!ongoingSessionData || !v2SessionId) return filteredSessions;
    return filteredSessions.filter((s) => s.txn_id !== v2SessionId);
  }, [filteredSessions, ongoingSessionData, v2SessionId]);

  const isCollapsed = permanentState === 'collapsed';

  return (
    <Sidebar collapsible="icon" className="border-border">
      <SidebarHeader>
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-1">
            <img src="/assets/vaarta-icon.svg" alt="vaarta" className="w-8 h-8" />
            <button
              className="cursor-pointer hidden md:flex p-1 rounded hover:bg-accent transition-colors"
              onClick={() => {
                setPermanentState('expanded');
                setOpen(true);
              }}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between px-2 py-2">
            <VaartaLogoLottie className="shrink-0" />
            <button
              className="cursor-pointer hidden md:flex p-1 rounded hover:bg-accent transition-colors"
              onClick={() => {
                setPermanentState('collapsed');
                setOpen(false);
              }}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className="overflow-y-auto">
        {!isCollapsed ? (
          <div className="flex flex-col h-full">
            <div className="px-3 pb-2">
              <Button
                variant="outline"
                onClick={handleNewSessionClick}
                disabled={isSessionActive || isStartingNewSession}
                className="w-full justify-center cursor-pointer gap-2 rounded-lg border-[#D1D1D1] text-primary hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="w-5 h-5" />
                <span className="text-sm font-medium">New Session</span>
              </Button>
            </div>
            <SidebarSearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search sessions"
              onRefresh={handleRefreshSessions}
              isRefreshing={isRefreshingSessions}
              filterGroups={sessionFilterGroups}
              onToggleFilterGroup={toggleSessionFilterGroup}
              onClearFilters={clearSessionFilters}
              isFilterActive={isSessionFilterActive}
              sortOrder={sessionSortOrder}
              onSortOrderChange={toggleSessionSortOrder}
            />
            <div className="flex-1 overflow-y-auto mt-0">
              <SidebarPastSessions
                sessions={displaySessions}
                loading={sessionsLoadingState}
                loadingMore={sessionsLoadingMoreState}
                error={sessionsErrorState}
                hasNextPage={hasNextPage}
                goToNextPage={goToNextPage}
                isSearching={isSearching}
                onDeleteSession={removeSession}
                ongoingSession={ongoingSessionData}
                refreshPastSessions={handleRefreshSessions}
                onCurrentSessionClick={handleCurrentSessionClick}
                activeRecordingSessionId={
                  !isNewSession && isPastSessionOngoing ? v2SessionId : undefined
                }
              />
            </div>
          </div>
        ) : null}
      </SidebarContent>

      {/* Update banner — desktop only, outside scroll area so it's always visible */}
      <DesktopOnly>
        {!isCollapsed &&
          (() => {
            let bannerProps: React.ComponentProps<typeof SidebarPromoBanner> | null = null;
            if (updatePhase === 'available' && updateVersion) {
              bannerProps = {
                icon: <RefreshCw className="w-5 h-5 text-[#2563EB]" />,
                iconContainerClassName: 'bg-[#DBEAFE]',
                title: `Update v${updateVersion}`,
                titleClassName: 'text-[#1E40AF]',
                subtitle: 'New version available',
                bannerClassName: 'bg-[#EFF6FF] border border-[#BFDBFE]',
                onClick: () => appUpdates?.install(),
              };
            } else if (updatePhase === 'downloading') {
              bannerProps = {
                icon: <RefreshCw className="w-5 h-5 text-[#2563EB] animate-spin" />,
                iconContainerClassName: 'bg-[#DBEAFE]',
                title: 'Downloading update',
                titleClassName: 'text-[#1E40AF]',
                progress: updateProgress,
                bannerClassName: 'bg-[#EFF6FF] border border-[#BFDBFE]',
                onClick: () => {},
              };
            } else if (updatePhase === 'ready') {
              bannerProps = {
                icon: <Check className="w-5 h-5 text-[#16A34A]" />,
                iconContainerClassName: 'bg-[#DCFCE7]',
                title: 'Update ready',
                titleClassName: 'text-[#15803D]',
                subtitle: 'Restart to apply update',
                bannerClassName: 'bg-[#F0FDF4] border border-[#BBF7D0]',
                onClick: () => appUpdates?.install(),
              };
            }
            return bannerProps ? <SidebarPromoBanner {...bannerProps} /> : null;
          })()}
      </DesktopOnly>

      {/* Bottom panels + icon bar */}
      <SidebarFooter className="gap-0 p-0">
        <div ref={footerRef} className="relative">
          {/* Profile panel */}
          {activePanel === 'profile' && (
            <SidebarBottomPanel
              isCollapsed={isCollapsed}
              onClose={() => setActivePanel(null)}
              header={
                <div className="flex items-center gap-2">
                  <div className="size-10 shrink-0 rounded-full bg-[#DBEAFE] flex items-center justify-center text-[#1E40AF] text-sm font-semibold">
                    {loggedInUserDetails?.fn || loggedInUserDetails?.ln ? (
                      `${(loggedInUserDetails?.fn?.[0] || '').toUpperCase()}${(
                        loggedInUserDetails?.ln?.[0] || ''
                      ).toUpperCase()}`
                    ) : (
                      <User className="size-5" strokeWidth={1.5} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#1A1A1A] truncate">
                      {(() => {
                        const fullName = [
                          loggedInUserDetails?.fn,
                          loggedInUserDetails?.mn,
                          loggedInUserDetails?.ln,
                        ]
                          .filter(Boolean)
                          .join(' ');
                        return (
                          [loggedInUserDetails?.s, fullName].filter(Boolean).join(' ') || 'User'
                        );
                      })()}
                    </p>
                    {loggedInUserDetails?.['w-n'] && (
                      <p className="text-xs text-[#6B7280] truncate">
                        {loggedInUserDetails['w-n']}
                      </p>
                    )}
                  </div>
                </div>
              }
            >
              <SidebarPanelItem
                icon={<Settings className="size-4 text-[#6B7280]" />}
                label="User Settings"
                onClick={() => {
                  setIsUserDefaultsOpen(true);
                  setActivePanel(null);
                }}
              />
              {/* <WebOnly>
                <SidebarPanelItem
                  icon={<ArrowLeftRight className="size-4 text-[#6B7280]" />}
                  label="Switch workspace"
                  onClick={() => {
                    const switchUrl =
                      process.env.NEXT_PUBLIC_ENV === 'PROD'
                        ? SWITCH_WORKSPACE_PROD_URL
                        : SWITCH_WORKSPACE_DEV_URL;
                    window.location.href = switchUrl;
                  }}
                />
              </WebOnly> */}
              <div className="border-t border-[#E5E5E5] my-1" />
              <SidebarPanelItem
                icon={<LogOut className="size-4 text-current" />}
                label="Log out"
                variant="destructive"
                onClick={() => handleUserLogout()}
              />
            </SidebarBottomPanel>
          )}

          {/* Bottom tab bar */}
          <div
            className={`flex items-start border-t border-[#D1D1D1] px-2 pb-3 ${
              isCollapsed ? 'flex-col gap-1 pt-2' : 'gap-3 pt-3'
            }`}
          >
            {/* Profile */}
            <CustomTooltip>
              <CustomTooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`size-9 cursor-pointer rounded-lg`}
                  onClick={() => {
                    tracker.track({
                      name: MIXPANEL_EVENT_NAME.SCRIBEWEB_SIDEBAR_CLICKS,
                      type: MIXPANEL_EVENT_TYPE.PROFILE,
                    });
                    setActivePanel(activePanel === 'profile' ? null : 'profile');
                  }}
                >
                  <span className="size-9 flex items-center justify-center rounded-md bg-linear-to-b from-[#FEF9E7] to-[#FEF3C7] text-[#854D0E] text-xs font-semibold border border-[#F5D580]">
                    {loggedInUserDetails?.fn || loggedInUserDetails?.ln ? (
                      `${(loggedInUserDetails?.fn?.[0] || '').toUpperCase()}${(
                        loggedInUserDetails?.ln?.[0] || ''
                      ).toUpperCase()}`
                    ) : (
                      <User className="size-5" strokeWidth={1.5} />
                    )}
                  </span>
                </Button>
              </CustomTooltipTrigger>
              <CustomTooltipContent collisionPadding={8}>
                {[
                  loggedInUserDetails?.s,
                  loggedInUserDetails?.fn,
                  loggedInUserDetails?.mn,
                  loggedInUserDetails?.ln,
                ]
                  .filter(Boolean)
                  .join(' ') || 'Profile'}
              </CustomTooltipContent>
            </CustomTooltip>

            {/* Templates */}
            <CustomTooltip>
              <CustomTooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`size-9 cursor-pointer rounded-lg ${
                    pathname.startsWith('/template')
                      ? 'text-primary bg-[#E9EFFF] hover:bg-[#E9EFFF] border border-primary'
                      : 'text-[#1A1A1A] hover:bg-[#F3F4F6]'
                  }`}
                  onClick={() => {
                    tracker.track({
                      name: MIXPANEL_EVENT_NAME.SCRIBEWEB_SIDEBAR_CLICKS,
                      type: MIXPANEL_EVENT_TYPE.TEMPLATES,
                    });
                    setActivePanel(null);
                    router.push('/template');
                  }}
                >
                  <LayoutTemplate className="size-5" strokeWidth={1.5} />
                </Button>
              </CustomTooltipTrigger>
              <CustomTooltipContent collisionPadding={8}>Templates</CustomTooltipContent>
            </CustomTooltip>

            {/* App download — web only */}
            <WebOnly>
              <CustomTooltip>
                <CustomTooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 cursor-pointer rounded-lg text-[#1A1A1A] hover:bg-[#F3F4F6]"
                    onClick={() =>
                      getPlatform().system?.openExternal(`${window.location.origin}/download`)
                    }
                  >
                    <Download className="size-5" strokeWidth={1.5} />
                  </Button>
                </CustomTooltipTrigger>
                <CustomTooltipContent collisionPadding={8}>App download</CustomTooltipContent>
              </CustomTooltip>
            </WebOnly>

            {/* Watch tutorial */}
            <SidebarTutorialButton />
          </div>
        </div>
      </SidebarFooter>
      <UserDefaultsDialog
        open={isUserDefaultsOpen}
        onOpenChange={(open) => {
          setIsUserDefaultsOpen(open);
          if (!open) {
            getStorage().session.remove('ekascribe:pending-modal');
          }
        }}
      />
    </Sidebar>
  );
};

export default CustomSidebar;
