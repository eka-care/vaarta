import { useMemo, useState } from 'react';
import { useIntersectionObserver } from '@/shared-hooks/use-intersection-observer';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@ui/src';
import { MoreVertical, Trash2, Loader2, History, User } from 'lucide-react';
import { getSDK } from '@/features/session/services/sdk-provider';
import { with401Retry } from '@/fetch-client/api-with-retry';
import ConfirmationDialog from '@/shared-components/dialog/confirmation-dialog';
import { TPastSessionHistoryData } from '@/constants/types';
import { formatDate, getDateGroupLabel } from '@/utils/format-date-time';
import useVoice2RxStore from '@/store/store';
import { useRouter, usePathname } from 'next/navigation';
import {
  CustomTooltip,
  CustomTooltipContent,
  CustomTooltipTrigger,
} from '@/shared-components/custom-tooltip';
import { getOngoingSessionStatus } from '@/features/session/utils/get-ongoing-session-processing-status';
import { useJumpToSelected } from '@/features/sidebar/hooks/use-jump-to-selected';
import JumpToSelectedChip from '@/features/sidebar/components/jump-to-selected-chip';
import { SESSION_PHASE } from '@/constants/enums';

// Map V2 phase to V1-compatible status for getOngoingSessionStatus
const V2_PHASE_TO_STATUS: Record<string, string> = {
  [SESSION_PHASE.RECORDING]: 'recording',
  [SESSION_PHASE.PAUSED]: 'paused',
  [SESSION_PHASE.PROCESSING]: 'analysing',
  [SESSION_PHASE.OUTPUT]: 'success',
  [SESSION_PHASE.ERROR]: 'system_failure',
};

const SidebarPastSessions = ({
  sessions,
  loading,
  loadingMore,
  error,
  hasNextPage,
  goToNextPage,
  isSearching = false,
  onDeleteSession,
  ongoingSession,
  onCurrentSessionClick,
  activeRecordingSessionId,
  refreshPastSessions,
}: {
  sessions: TPastSessionHistoryData[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasNextPage: boolean;
  goToNextPage: () => void;
  isSearching?: boolean;
  onDeleteSession?: (txnId: string) => void;
  ongoingSession?: {
    processingStatus: string;
  } | null;
  onCurrentSessionClick?: () => void;
  activeRecordingSessionId?: string;
  refreshPastSessions?: () => void;
}) => {
  const [clickedSessionId, setClickedSessionId] = useState<string | null>(null);
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null);
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const v2Phase = useVoice2RxStore(
    (state) => state.sessionV2ContentById[state.sessionV2Ongoing.recording_session_id]?.phase
  );
  const ongoingSessionTitle = useVoice2RxStore(
    (state) =>
      (state.sessionV2ContentById[state.sessionV2Ongoing.recording_session_id]?.session_details
        ?.title as string | undefined) || ''
  );
  const sessionV2ContentById = useVoice2RxStore((state) => state.sessionV2ContentById);
  const router = useRouter();
  const pathname = usePathname();

  // group sessions by date
  const groupedSessionsByDate = useMemo(() => {
    if (!Array.isArray(sessions) || sessions?.length === 0) return {};

    return sessions.reduce<Record<string, TPastSessionHistoryData[]>>((acc, session) => {
      if (!session?.created_at) return acc;
      const { date } = formatDate(session.created_at);
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(session);

      return acc;
    }, {});
  }, [sessions]);

  const ongoingStatus = useMemo(() => {
    if (!ongoingSession) return null;
    return getOngoingSessionStatus({ processingStatus: ongoingSession.processingStatus });
  }, [ongoingSession?.processingStatus]);

  const isAnyPastSessionSelected = useMemo(() => {
    if (clickedSessionId !== null) return true;
    return sessions.some((s) => pathname === `/session/${s.txn_id}`);
  }, [sessions, pathname, clickedSessionId]);

  const isCurrentSessionSelected = !isAnyPastSessionSelected;

  const { scrollBodyRef, showChip, direction, jumpToSelected } = useJumpToSelected(
    `${pathname}|${clickedSessionId ?? ''}`,
    sessions
  );

  const sentinelRef = useIntersectionObserver({
    onIntersect: goToNextPage,
    enabled: hasNextPage && !isSearching && !loadingMore,
    root: scrollBodyRef.current,
    rootMargin: '0px',
    threshold: 0.1,
  });

  const handleSessionClick = ({ sessionId }: { sessionId: string; sessionStatus: string }) => {
    setClickedSessionId(sessionId);

    const targetPath = `/session/${sessionId}`;
    if (pathname === targetPath) {
      setClickedSessionId(null);
      return;
    }

    router.push(targetPath as any);
    setClickedSessionId(null);
  };

  const handleDeleteSession = async () => {
    if (!sessionToDelete) return;

    setIsDeletingSession(true);

    onDeleteSession?.(sessionToDelete);

    try {
      const deleteSessionResponse = await with401Retry(
        () => getSDK().sessions.deleteSession({ txn_id: sessionToDelete }),
        'delete session'
      );

      if (deleteSessionResponse.status_code >= 400) {
        throw new Error('Failed to delete session');
      }

      useVoice2RxStore.getState().setWarningInfo({
        message: 'Session deleted',
        type: 'success',
        screen: 'start_session',
      });

      if (pathname === `/session/${sessionToDelete}`) {
        router.push('/new-session');
      }
    } catch {
      useVoice2RxStore.getState().setWarningInfo({
        message: 'Failed to delete session. Please try again.',
        type: 'error',
        screen: 'start_session',
      });

      refreshPastSessions?.();
    } finally {
      setIsDeletingSession(false);
      setSessionToDelete(null);
    }
  };

  if (loading && sessions.length === 0) {
    return (
      <div className="p-4 text-center">
        <div className="flex items-center justify-center">
          <Loader2 className="w-4 h-4 text-primary animate-spin" />
          <span className="ml-2 text-xs text-muted-foreground">Loading sessions...</span>
        </div>
      </div>
    );
  }

  // Empty state for search with no results
  if (isSearching && sessions.length === 0) {
    return (
      <div className="p-4 text-center">
        <p className="text-xs text-muted-foreground">No sessions found</p>
      </div>
    );
  }

  // Empty state when no sessions exist
  if (!loading && sessions.length === 0 && !isSearching && !ongoingSession) {
    return (
      <div className="flex flex-col gap-3 px-3 pt-4">
        <div className="w-10 h-10 rounded-lg bg-[#FFF3CD] border border-[#B45309] flex items-center justify-center">
          <History className="w-5 h-5 text-[#B45309]" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-base font-semibold text-[#1A1A1A]">No past sessions</p>
          <p className="text-sm font-normal text-[#767676] text-balance">
            Your completed sessions will appear here once you&apos;ve finished your first recording.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-full">
      {/* Sessions List - Scrollable */}
      <div className="flex-1 overflow-y-auto overscroll-y-contain" ref={scrollBodyRef}>
        {/* Ongoing session card — highlighted, clickable to resume */}
        {ongoingSession && ongoingStatus && !isSearching && (
          <div className="flex flex-col">
            <div className="flex flex-col px-3 pt-3 pb-1 gap-3">
              <div className="border-t border-[#D1D1D1] opacity-50" />
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-[#767676]">
                  Current Session
                </span>
              </div>
            </div>
            <div
              onClick={onCurrentSessionClick}
              data-jump-active={isCurrentSessionSelected || undefined}
              className={`flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors ${
                isCurrentSessionSelected ? 'bg-[#E9EFFF]' : 'hover:bg-[#F5F5F5]'
              }`}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-[#F5F5F5] border border-[#D1D1D1] text-[#767676]">
                <User className="w-3.5 h-3.5" />
              </div>
              <div className="flex flex-col  gap-px flex-1 min-w-0">
                <p className="text-xs truncate leading-4 capitalize font-medium text-[#1A1A1A]">
                  {ongoingSessionTitle || 'New Session'}
                </p>
                <div className="flex items-center justify-between gap-1">
                  <p className="text-xs leading-4 text-secondary-foreground">
                    {ongoingStatus.label}
                  </p>
                </div>
              </div>
              {ongoingStatus.icon && (
                <CustomTooltip>
                  <CustomTooltipTrigger asChild>{ongoingStatus.icon}</CustomTooltipTrigger>
                  <CustomTooltipContent>{ongoingStatus.label}</CustomTooltipContent>
                </CustomTooltip>
              )}

              {isCurrentSessionSelected && <div className="w-1 h-8 rounded-sm bg-primary" />}
            </div>
          </div>
        )}

        {Object.entries(groupedSessionsByDate).map(([date, dateSessions]) => {
          const relativeLabel = getDateGroupLabel(date);

          return (
            <div key={date} className="flex flex-col">
              <div className="flex flex-col px-3 pt-3 pb-1 gap-3">
                <div className="border-t border-[#D1D1D1] opacity-50" />
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-[#767676]">
                    {date}
                  </span>
                  {relativeLabel && (
                    <span className="text-[10px] font-normal text-primary">{relativeLabel}</span>
                  )}
                </div>
              </div>

              {/* Session cards */}
              {dateSessions.map((session) => {
                const { time } = formatDate(session.created_at);
                const storeContent = sessionV2ContentById[session.txn_id];
                // Title lives in session_details, which the /history row
                // already carries. Prefer the store so a rename made during
                // this visit shows without a refetch, then fall back to the
                // list row. Reading ONLY the store is what made every
                // not-yet-opened session render as "Session at HH:MM" until
                // it was clicked.
                const sessionTitle =
                  (storeContent?.session_details?.title as string | undefined) ||
                  session.session_details?.title ||
                  null;

                // Check if pathname matches this session (navigation completed)
                const isPathnameMatch = pathname === `/session/${session.txn_id}`;

                const isClickedSession = clickedSessionId === session.txn_id && !isPathnameMatch;

                const isActiveRecording = activeRecordingSessionId === session.txn_id;

                const storePhase = sessionV2ContentById[session.txn_id]?.phase;
                const storeDisplayStatus = storePhase
                  ? (V2_PHASE_TO_STATUS[storePhase] ?? null)
                  : null;

                const effectiveProcessingStatus = isActiveRecording
                  ? V2_PHASE_TO_STATUS[v2Phase] || v2Phase
                  : isClickedSession
                    ? 'analysing'
                    : storeDisplayStatus || session.processing_status;

                const sessionProcessingStatus = getOngoingSessionStatus({
                  processingStatus: effectiveProcessingStatus,
                });

                const hasNotesReady = effectiveProcessingStatus === 'success';

                const isSelectedSession = isPathnameMatch || isClickedSession;
                const isHovered = hoveredSessionId === session.txn_id;

                return (
                  <div
                    key={session.txn_id}
                    data-jump-active={isSelectedSession || undefined}
                    className={`relative flex items-center gap-2 pl-2 pr-3 py-2 cursor-pointer transition-colors ${
                      isSelectedSession
                        ? 'bg-[#E9EFFF]'
                        : isHovered || openDropdownId === session.txn_id
                          ? 'bg-[#F5F5F5]'
                          : 'hover:bg-[#F5F5F5]'
                    }`}
                    onClick={() => {
                      handleSessionClick({
                        sessionId: session.txn_id,
                        sessionStatus: session.processing_status,
                      });
                    }}
                    onMouseEnter={() => setHoveredSessionId(session.txn_id)}
                    onMouseLeave={() => {
                      if (openDropdownId !== session.txn_id) setHoveredSessionId(null);
                    }}
                  >
                    {/* Session avatar */}
                    <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-[#F5F5F5] border border-[#D1D1D1] text-[#767676]">
                      <User className="w-3.5 h-3.5" />
                    </div>

                    {/* Card content */}
                    <div className="flex flex-col gap-px flex-1 min-w-0">
                      {sessionTitle ? (
                        <>
                          <p className="text-xs truncate leading-4 font-medium text-[#1A1A1A]">
                            {sessionTitle}
                          </p>
                          <p className="text-xs leading-4 text-[#767676]">
                            {hasNotesReady ? `${time} · Notes Ready` : time}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-xs truncate leading-4 font-medium text-[#1A1A1A]">
                            Session at {time}
                          </p>
                          <p className="text-xs leading-4 text-[#767676]">
                            {hasNotesReady ? 'Notes Ready' : '+ Add title'}
                          </p>
                        </>
                      )}
                    </div>

                    <div className="shrink-0 flex items-center gap-1 w-[38px] justify-end">
                      <CustomTooltip>
                        <CustomTooltipTrigger asChild>
                          <div className="cursor-pointer shrink-0 w-[18px] h-[18px] flex items-center justify-center">
                            {sessionProcessingStatus.icon}
                          </div>
                        </CustomTooltipTrigger>
                        <CustomTooltipContent>{sessionProcessingStatus.label}</CustomTooltipContent>
                      </CustomTooltip>

                      <DropdownMenu
                        onOpenChange={(open) => {
                          setOpenDropdownId(open ? session.txn_id : null);
                          if (!open) setHoveredSessionId(null);
                        }}
                      >
                        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                          <button className="cursor-pointer p-0.5 rounded-sm hover:bg-accent">
                            <MoreVertical className="w-4 h-4 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="bottom"
                          align="start"
                          sideOffset={4}
                          className="min-w-[180px] rounded-md border-[#D1D1D1] p-1 shadow-md"
                        >
                          <DropdownMenuItem
                            className="cursor-pointer gap-2 text-sm font-normal text-[#D92D20] focus:text-[#D92D20]"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSessionToDelete(session.txn_id);
                            }}
                          >
                            <Trash2 className="w-4 h-4 text-[#D92D20]" />
                            Delete session
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {isSelectedSession && (
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 w-1 h-8 rounded-sm bg-primary" />
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {/* Error state */}
        {error && (
          <div className="p-4 text-center">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {hasNextPage && !isSearching && (
          <div ref={sentinelRef} className="flex justify-center py-2">
            {loadingMore && <Loader2 className="w-4 h-4 text-primary animate-spin" />}
          </div>
        )}
      </div>

      {showChip && <JumpToSelectedChip direction={direction} onClick={jumpToSelected} />}

      <ConfirmationDialog
        title="Delete Session"
        description="Are you sure you want to delete this session? This action cannot be undone."
        variant="destructive"
        confirmText={isDeletingSession ? 'Deleting...' : 'Delete'}
        open={sessionToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSessionToDelete(null);
        }}
        onConfirm={handleDeleteSession}
      />
    </div>
  );
};

export default SidebarPastSessions;
