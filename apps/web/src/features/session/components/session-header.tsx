'use client';

import { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  Loader2,
  SquarePen,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import WaveformIcon from '@/assets/waveform-icon';
import { Popover, PopoverContent, PopoverTrigger } from '@ui/src';
import {
  CustomTooltip,
  CustomTooltipContent,
  CustomTooltipTrigger,
} from '@/shared-components/custom-tooltip';
import useVoice2RxStore from '@/store/store';
import { SESSION_PHASE } from '@/constants/enums';
import { getSessionErrorContent } from './output/error-component';
import { formatRecordedAt } from '../utils/format-recorded-at';
import { AudioWaveformTimer } from './recording/audio-waveform-timer';
import AudioQualitySummary from './recording/audio-quality-summary';
import DownloadAudioButton from '@/features/session/components/recording/download-audio-button';
import { useSessionLifecycle } from '../hooks/use-session-lifecycle';
import { useSessionView } from '../hooks/use-session-view';
import SessionTitleField from './session-title-field';
import { toast } from 'sonner';
import ConfirmationDialog from '@/shared-components/dialog/confirmation-dialog';

interface SessionHeaderProps {
  sessionId: string;
  isPastSession?: boolean;
  onEditPreferences?: () => void;
  onAddTranscriptOrVoice: () => void;
  isAnotherSessionActive?: boolean;
  isLimitExceeded?: boolean;
  onShowLimitDialog?: () => void;
  microphoneSelector?: React.ReactNode;
}

const SessionHeader = ({
  sessionId,
  isPastSession,
  onEditPreferences,
  onAddTranscriptOrVoice,
  isAnotherSessionActive,
  isLimitExceeded,
  onShowLimitDialog,
  microphoneSelector,
}: SessionHeaderProps) => {
  const {
    phase,
    error: sessionError,
    canStartRecording,
    showEditPreferences,
    showMicSelector,
  } = useSessionView(sessionId);

  const sessionConfig = useVoice2RxStore((s) => s.sessionV2ContentById[sessionId]?.session_config);
  const templateNameById = useVoice2RxStore((s) => s.templateNameById);
  const createdAt = useVoice2RxStore((s) => s.sessionV2ContentById[sessionId]?.created_at || '');

  // Lifecycle handlers from hook
  const {
    startRecording,
    pauseRecording,
    resumeRecording,
    endRecording,
    discardSession,
    stopProcessing,
    isStartSessionLoading,
  } = useSessionLifecycle();

  const [isRecordingDropdownOpen, setIsRecordingDropdownOpen] = useState(false);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);

  const isOutput = phase === SESSION_PHASE.OUTPUT;

  const inputLanguagesText = useMemo(() => {
    const langs = sessionConfig?.input_languages;
    return langs?.length ? langs.map((l) => l.name).join(', ') : '';
  }, [sessionConfig]);

  const outputFormatText = useMemo(() => {
    const templates = sessionConfig?.output_format_template;
    if (!templates?.length) return '';
    return templates
      .map((t) => templateNameById[t.id] || t.name)
      .filter(Boolean)
      .join(', ');
  }, [sessionConfig, templateNameById]);

  const handleAnotherSessionActiveClick = () => {
    useVoice2RxStore.getState().setWarningInfo({
      screen: 'recording',
      message: 'Another recording session is active. Please end it before starting a new one.',
    });
  };

  const handleStartRecordingClick = () => {
    if (isLimitExceeded) {
      onShowLimitDialog?.();
      return;
    }
    if (isAnotherSessionActive) {
      handleAnotherSessionActiveClick?.();
      return;
    }
    startRecording(sessionId);
  };

  const isNotStarted = phase === SESSION_PHASE.IDLE;
  const isRecording = phase === SESSION_PHASE.RECORDING || phase === SESSION_PHASE.PAUSED;
  const isPaused = phase === SESSION_PHASE.PAUSED;
  const isProcessing = phase === SESSION_PHASE.PROCESSING;

  const settingsItems = useMemo(
    () => [inputLanguagesText, outputFormatText].filter(Boolean),
    [inputLanguagesText, outputFormatText]
  );

  const recordedAtText = useMemo(() => formatRecordedAt(createdAt), [createdAt]);

  const showSessionError = phase === SESSION_PHASE.ERROR && !!sessionError;
  const sessionErrorContent = sessionError ? getSessionErrorContent(sessionError) : null;

  const headerErrorLabel = showSessionError ? sessionErrorContent?.title : null;
  const headerErrorMessage = showSessionError ? sessionErrorContent?.description : null;

  return (
    <div className="grid grid-cols-[auto_1fr] sm:grid-cols-[1fr_auto] items-start gap-2 w-full p-4">
      {/* 1. Session title — full width on mobile, col 1 on desktop */}
      <div className="col-span-2 sm:col-span-1 w-full sm:w-auto min-w-0 flex items-center gap-2">
        {/* sm:flex-none (not flex-1) so the model selector sits right beside
            the title box instead of being pushed to the far edge */}
        <div className="flex-1 sm:flex-none min-w-0">
          <SessionTitleField
            sessionId={sessionId}
            disabled={phase === SESSION_PHASE.PROCESSING || !!isLimitExceeded}
          />
        </div>
        {isOutput && (
          <div className="sm:hidden shrink-0">
            <DownloadAudioButton sessionID={sessionId} />
          </div>
        )}
      </div>

      {/* 2. Recording controls — beside patient on desktop, row 2 col 1 on mobile. */}
      <div
        className={`col-span-2 sm:col-span-1 flex flex-col items-stretch sm:items-end justify-center gap-4 w-full ${
          isNotStarted ? '' : 'sm:row-span-2'
        }`}
      >
        {headerErrorMessage && (
          <div className="flex items-center gap-1.5 self-end">
            <CustomTooltip>
              <CustomTooltipTrigger asChild>
                <div className="shrink-0 w-4.5 h-4.5 flex items-center justify-center">
                  <TriangleAlert className="w-4 h-4 text-[#D92D20]" />
                </div>
              </CustomTooltipTrigger>
              <CustomTooltipContent>{headerErrorMessage}</CustomTooltipContent>
            </CustomTooltip>
            <span className="text-xs font-medium text-[#D92D20]">{headerErrorLabel}</span>
          </div>
        )}

        {canStartRecording && (
          <div className="relative w-full sm:w-56">
            <Popover open={isRecordingDropdownOpen} onOpenChange={setIsRecordingDropdownOpen}>
              <div className="flex items-center rounded-lg overflow-hidden w-full">
                <button
                  onClick={handleStartRecordingClick}
                  disabled={isStartSessionLoading}
                  className={`flex items-center justify-center gap-2 px-4 w-full h-10 text-sm font-medium text-white whitespace-nowrap transition-colors ${
                    isPastSession ? 'rounded-lg' : 'rounded-l-lg'
                  } ${
                    isAnotherSessionActive
                      ? 'bg-[#039855]/50 cursor-not-allowed'
                      : 'bg-[#039855] cursor-pointer hover:bg-[#16A34A]/90 disabled:opacity-70'
                  }`}
                >
                  {isStartSessionLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                  ) : (
                    <>
                      <WaveformIcon />
                      Start transcribing
                    </>
                  )}
                </button>
                {!isPastSession && (
                  <PopoverTrigger asChild disabled={isAnotherSessionActive || isLimitExceeded}>
                    <button
                      className={`flex items-center justify-center h-10 px-3 border-l border-[rgba(241,245,249,0.4)] transition-colors rounded-r-lg ${
                        isAnotherSessionActive || isLimitExceeded
                          ? 'bg-[#039855]/50 cursor-not-allowed'
                          : 'bg-[#039855] cursor-pointer hover:bg-[#16A34A]/90'
                      }`}
                    >
                      <ChevronDown className="w-4 h-4 text-white" />
                    </button>
                  </PopoverTrigger>
                )}
              </div>

              <PopoverContent
                align="end"
                sideOffset={4}
                className="w-69 p-1 border border-[#D1D1D1] rounded-md shadow-md bg-white"
              >
                <button
                  onClick={() => {
                    setIsRecordingDropdownOpen(false);
                    onAddTranscriptOrVoice();
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm text-[#1A1A1A] hover:bg-[#F5F5F5] rounded cursor-pointer transition-colors"
                >
                  <span className="flex-1 text-left">Upload voice recording</span>
                  <Upload className="w-4 h-4 shrink-0" />
                </button>
              </PopoverContent>
            </Popover>
          </div>
        )}

        {isRecording && (
          <div className="flex flex-col items-end gap-2 w-full sm:w-auto">
            <div className="flex items-center gap-2">
              {isPaused ? (
                <button
                  key="resume"
                  onClick={resumeRecording}
                  className="h-7 min-w-16 px-3 rounded-lg bg-[#008055] text-white text-sm font-medium cursor-pointer hover:bg-[#008055]/90"
                >
                  Resume
                </button>
              ) : (
                <button
                  key="pause"
                  onClick={pauseRecording}
                  className="h-7 min-w-16 px-3 rounded-lg bg-accent text-primary text-sm font-medium cursor-pointer hover:bg-accent/90"
                >
                  Pause
                </button>
              )}

              <button
                onClick={endRecording}
                className="h-7 min-w-16 px-3 rounded-lg bg-[#D92D20] text-white text-sm font-medium cursor-pointer hover:bg-[#D92D20]/90 transition-colors"
              >
                End session
              </button>

              <CustomTooltip>
                <CustomTooltipTrigger asChild>
                  <button
                    className="cursor-pointer shrink-0 p-1.5 rounded-md hover:bg-destructive/10 transition-colors"
                    onClick={() => setShowDiscardDialog(true)}
                  >
                    <Trash2 className="w-4 h-4 text-[#D92D20]" />
                  </button>
                </CustomTooltipTrigger>
                <CustomTooltipContent>Discard session</CustomTooltipContent>
              </CustomTooltip>
            </div>

            <AudioWaveformTimer sessionId={sessionId} />
          </div>
        )}

        {isProcessing && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 px-2 py-1 bg-white border border-[#D1D1D1] rounded-lg text-sm font-medium text-foreground opacity-50">
              Generating notes
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>

            <CustomTooltip>
              <CustomTooltipTrigger asChild>
                <button
                  className="cursor-pointer shrink-0 p-1.5 rounded-md hover:bg-destructive/10 transition-colors"
                  onClick={stopProcessing}
                >
                  <Trash2 className="w-4 h-4 text-[#D92D20]" />
                </button>
              </CustomTooltipTrigger>
              <CustomTooltipContent>Stop processing</CustomTooltipContent>
            </CustomTooltip>
          </div>
        )}

        {isOutput && (
          <div className="hidden sm:flex flex-col items-end gap-3">
            {recordedAtText && (
              <div className="flex items-center gap-1">
                <Check className="w-4 h-4 shrink-0 text-[#767676]" />
                <span className="text-xs leading-4 text-[#767676] whitespace-nowrap">
                  Session complete · {recordedAtText}
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <AudioQualitySummary sessionId={sessionId} />
              <DownloadAudioButton sessionID={sessionId} />
              <CustomTooltip>
                <CustomTooltipTrigger asChild>
                  <button
                    className="cursor-pointer shrink-0 p-1.5 rounded-lg hover:bg-destructive/10 transition-colors"
                    onClick={() => setShowDiscardDialog(true)}
                  >
                    <Trash2 className="w-4 h-4 text-[#D92D20]" />
                  </button>
                </CustomTooltipTrigger>
                <CustomTooltipContent collisionPadding={8}>Discard session</CustomTooltipContent>
              </CustomTooltip>
            </div>
          </div>
        )}
      </div>

      {/* 3. Settings meta — full width row on mobile, col 1 row 2 on desktop */}
      <div className="col-span-2 sm:col-span-1 flex flex-col space-y-1.5 px-2 min-w-0">
        <div className="flex items-center flex-wrap gap-4">
          <div className="flex items-center flex-wrap gap-2">
            {settingsItems.map((item, index) => (
              <span key={index} className="flex items-center gap-2">
                {index > 0 && <span className="w-1 h-1 rounded-full bg-foreground" />}
                <span className="text-xs text-foreground capitalize">{item}</span>
              </span>
            ))}
            {sessionId && (
              <span className="flex items-center gap-2">
                {settingsItems.length > 0 && (
                  <span className="w-1 h-1 rounded-full bg-foreground" />
                )}
                <span className="text-xs text-foreground">{sessionId}</span>
              </span>
            )}
          </div>

          {showEditPreferences && onEditPreferences && (
            <button
              onClick={() => {
                if (isLimitExceeded) {
                  toast.info('Session limit reached. Please upgrade to continue.');
                  return;
                }
                onEditPreferences?.();
              }}
              className={`flex items-center gap-1 ${
                isLimitExceeded ? 'cursor-not-allowed' : 'cursor-pointer'
              } hover:opacity-80 transition-opacity`}
            >
              <SquarePen className="w-4 h-4 text-[#215FFF]" />
              <span className="text-xs font-medium">Edit</span>
            </button>
          )}
        </div>
      </div>

      {/* 4. Microphone — beside Start on mobile (row 2 col 2), under Start on desktop (row 2 col 2) */}
      {showMicSelector && (
        <div className="col-start-2 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto sm:w-56">
          {microphoneSelector}
        </div>
      )}

      <ConfirmationDialog
        title="Discard this session?"
        description="This action cannot be undone — the recording and transcript will be lost."
        variant="destructive"
        confirmText="Discard this session"
        open={showDiscardDialog}
        onOpenChange={setShowDiscardDialog}
        onConfirm={() => {
          if (isProcessing) {
            stopProcessing();
          } else {
            discardSession(sessionId);
          }
        }}
      />
    </div>
  );
};

export default SessionHeader;
