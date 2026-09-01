'use client';

import { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useRouter } from 'next/navigation';
import useVoice2RxStore from '@/store/store';
import { with401Retry } from '@/fetch-client/api-with-retry';
import getSystemInfo from '@/utils/get-system-info';
import { getPlatform } from '@/platform';
import { useMicrophonePermission } from '@/features/session/hooks/recording/use-microphone-permission';
import * as sdkService from '../services/sdk-service';
import {
  loadSessionDetails,
  pollAndLoadSessionDetails,
  abortPolling,
} from '../services/session-loader';
import { getFlavour } from '@/platform';
import { SESSION_PHASE, MIXPANEL_EVENT_NAME, MIXPANEL_EVENT_TYPE } from '@/constants/enums';
import { tracker, setSessionContext } from '@/analytics';
import { ERROR_CODE } from '@eka-care/ekascribe-ts-sdk';
import { getSDK } from '../services/sdk-provider';
import { discardAndCleanup } from '../utils/discard-session';

function teardownSessionMixing() {
  getPlatform().audioCapture?.teardownSessionMixing?.();
}

// Module-level dedup flags
let activeCreatePromise: Promise<string | null> | null = null;
let _startRecordingInFlight = false;
let _endRecordingInFlight = false;
let _discardInFlight = false;

export function useSessionLifecycle() {
  const router = useRouter();
  const [isStartSessionLoading, setIsStartSessionLoading] = useState(false);

  const { checkMicrophonePermission } = useMicrophonePermission({
    screen_name: 'start_session',
  });

  // --- Create Session ---
  const createSession = useCallback(
    async ({
      encounter_id,
      upload_type = 'chunked',
      force = false,
    }: {
      templates?: string[];
      encounter_id?: string;
      upload_type?: 'chunked' | 'single';
      // Bypass the reuse guard to replace a stale pointer with a fresh session.
      force?: boolean;
    } = {}): Promise<string | null> => {
      const store = useVoice2RxStore.getState();
      const { sessionV2Ongoing } = store;

      // Guard: already have a session
      if (!force && sessionV2Ongoing.recording_session_id && !activeCreatePromise) {
        return sessionV2Ongoing.recording_session_id;
      }

      // Guard: create already in-flight
      if (activeCreatePromise) return activeCreatePromise;

      activeCreatePromise = (async () => {
        const sessionId = 'sc-' + uuidv4().replace(/-/g, '').slice(0, 28);
        const createStartMs = Date.now();

        try {
          const { userLevelPreferences } = useVoice2RxStore.getState();

          // Snapshot the user's defaults as this session's own config. New sessions always start from default config.
          const newSessionConfig = {
            input_languages: userLevelPreferences.input_languages,
            output_format_template: userLevelPreferences.output_format_template,
            consultation_mode: 'dictation',
            model_type: 'pro',
          };

          // Initialize content and recording ID early so the session screen renders
          // while the API call is in flight. On failure we must NOT clear
          // recording_session_id — the /new-session page watches for the transition
          // (prev && !sessionId) and would remount SessionScreen, causing an infinite loop.
          store.setSessionV2Content(sessionId, {
            phase: SESSION_PHASE.IDLE,
            session_config: newSessionConfig,
          });
          store.setRecordingSessionId(sessionId);
          store.setNewSessionId(sessionId);

          const inputLanguage = userLevelPreferences.input_languages.map((l) => l.id);
          const outputTemplates = userLevelPreferences.output_format_template.map((t) => t.id);
          const systemInfo = await getSystemInfo();

          // Also mirrored into the store below: the session PATCH replaces
          // additional_data wholesale, so title edits must merge against this.
          const additionalData = {
            model_training_consent: userLevelPreferences.model_training_consent.value,
            system_info: systemInfo,
            ...(encounter_id ? { encounter_id } : {}),
            _flavour: getFlavour(),
            input_languages: userLevelPreferences.input_languages,
            output_format_template: userLevelPreferences.output_format_template,
            model_type: 'pro',
            consultation_mode: 'dictation',
          };

          const response = await with401Retry(
            () =>
              sdkService.createSession(
                {
                  session_id: sessionId,
                  templates: outputTemplates,
                  language_hint: inputLanguage,
                  model: 'pro',
                  transcript_language: userLevelPreferences.output_language || 'en-IN',
                  upload_type,
                  communication_protocol: 'http',
                  session_mode: 'dictation',
                  additional_data: additionalData,
                },
                'v2'
              ),
            'create session'
          );

          if (!response.success || !response.data) {
            // txn_limit_exceeded → show upgrade modal
            if (
              !response.success &&
              response.error.httpStatus === 400 &&
              response.error.code === 'txn_limit_exceeded'
            ) {
              store.setSessionV2Content(sessionId, {
                is_limit_exceeded: true,
              });
              return sessionId;
            }

            const errorMessage = !navigator.onLine
              ? 'No Internet. Please check your connection.'
              : 'Something went wrong. Please try again.';
            const apiCode = !response.success ? response.error?.code : undefined;
            tracker.log({
              name: 'create_session_failed',
              properties: {
                session_id: sessionId,
                message: errorMessage,
                api_code: apiCode,
                duration_ms: Date.now() - createStartMs,
                network_online: navigator.onLine,
              },
            });
            store.setSessionV2Content(sessionId, {
              phase: SESSION_PHASE.ERROR,
              error: {
                code: 'create_session_failed',
                message: errorMessage,
                api_code: apiCode,
              },
            });
            return null;
          }

          const { session_id, upload_url, expires_at, created_at } = response.data;

          // If the server returned a different ID, clean up the optimistic content entry
          if (session_id !== sessionId) {
            store.clearSessionV2Content(sessionId);
          }

          // Update pointer to the server-confirmed ID and populate API fields
          store.setRecordingSessionId(session_id);
          store.setNewSessionId(session_id);
          store.setSessionV2Content(session_id, {
            phase: SESSION_PHASE.IDLE,
            created_at: created_at || '',
            upload_url: upload_url || {},
            expires_at: expires_at || '',
            additional_data: additionalData,
            session_config: newSessionConfig,
          });

          setSessionContext(session_id);
          tracker.log({
            name: 'session_created',
            properties: { session_id: session_id, duration_ms: Date.now() - createStartMs },
          });
          tracker.track({
            name: MIXPANEL_EVENT_NAME.SCRIBEWEB_NEW_SESSION,
            properties: { session_id: session_id },
          });

          return session_id;
        } catch (error) {
          console.error('createSession error:', error);
          tracker.error(error, {
            domain: 'recording',
            component: 'voice_api',
            tags: { error_code: 'create_session_failed' },
            extra: { session_id: sessionId, network_online: navigator.onLine },
          });
          store.setSessionV2Content(sessionId, {
            phase: SESSION_PHASE.ERROR,
            error: {
              code: 'create_session_failed',
              message: 'Something went wrong. Please try again.',
            },
          });
          return null;
        } finally {
          activeCreatePromise = null;
        }
      })();

      return activeCreatePromise;
    },
    []
  );

  // --- Load Existing Session ---
  // Returns whether the session exists on the backend (created_at is set only when found).
  const loadSession = useCallback(async (sessionId: string): Promise<boolean> => {
    const store = useVoice2RxStore.getState();

    // Already-loaded sessions (preloaded by the entry gate, or persisted) revalidate silently
    const alreadyLoaded = Boolean(store.sessionV2ContentById[sessionId]?.created_at);

    if (!alreadyLoaded) {
      store.setSessionV2Content(sessionId, { phase: SESSION_PHASE.IDLE });
      store.setSessionV2Ui(sessionId, { loading: true });
    }

    try {
      await loadSessionDetails(sessionId);
      store.setSessionV2Ui(sessionId, { loading: false, poll_status: 'idle' });
      return (
        alreadyLoaded ||
        Boolean(useVoice2RxStore.getState().sessionV2ContentById[sessionId]?.created_at)
      );
    } catch (error) {
      console.error('loadSession error:', error);
      store.setSessionV2Ui(sessionId, { loading: false });
      return alreadyLoaded;
    }
  }, []);

  // --- Start Recording ---
  const startRecording = useCallback(
    async (sessionId: string) => {
      if (isStartSessionLoading || _startRecordingInFlight) return;

      const store = useVoice2RxStore.getState();
      const { selectedMicrophone } = store;
      const sessionContent = store.sessionV2ContentById[sessionId];

      if (!sessionId || !sessionContent) return;

      _startRecordingInFlight = true;
      setIsStartSessionLoading(true);

      const micPermission = await checkMicrophonePermission();
      if (!micPermission) {
        tracker.log({
          name: 'mic_permission_denied',
          properties: { session_id: sessionId },
        });
        setIsStartSessionLoading(false);
        _startRecordingInFlight = false;
        return;
      }

      try {
        const createdAtSeconds = sessionContent.created_at
          ? isNaN(Number(sessionContent.created_at))
            ? Math.floor(new Date(sessionContent.created_at).getTime() / 1000)
            : Number(sessionContent.created_at)
          : Math.floor(Date.now() / 1000);

        teardownSessionMixing();
        try {
          await getPlatform().audioCapture?.installSessionMixing?.(selectedMicrophone?.deviceId);
        } catch (error) {
          console.warn(
            'Could not enable system audio capture, continuing with microphone only',
            error
          );
          tracker.log({
            name: 'mic_access_failed',
            properties: {
              session_id: sessionId,
              error_message: error instanceof Error ? error.message : String(error),
            },
          });
          teardownSessionMixing();
        }

        const response = await with401Retry(
          () =>
            sdkService.startRecordingForExistingSession({
              txn_id: sessionId,
              created_at: createdAtSeconds,
              microphoneID: selectedMicrophone?.deviceId,
              expires_at: sessionContent.expires_at,
              upload_url: sessionContent.upload_url,
              version: 'v2',
            }),
          'start recording for existing session'
        );

        if (response.status_code && response.status_code >= 400) {
          store.setWarningInfo({
            message: response.message || 'Failed to start recording. Please try again.',
            type: 'error',
            screen: 'recording',
          });
          setIsStartSessionLoading(false);
          _startRecordingInFlight = false;
          teardownSessionMixing();
          return;
        }

        // Mark this session as the active recording
        store.setRecordingSessionId(sessionId);

        store.setSessionV2Content(sessionId, {
          phase: SESSION_PHASE.RECORDING,
          session_duration: 0,
          audio_amplitudes: [],
          uploaded_chunks: [],
          upload_progress: { success: 0, total: 0 },
          error: null,
        });

        tracker.log({
          name: MIXPANEL_EVENT_NAME.SCRIBEWEB_NEW_SESSION,
          type: MIXPANEL_EVENT_TYPE.START_RECORDING,
        });

        with401Retry(
          () =>
            getSDK().sessions.patchSessionStatus({ user_status: 'recording_started' }, sessionId),
          'patch recording_started'
        ).catch(() => {});

        const { playAudioCues } = store;
        if (playAudioCues) {
          new Audio('/audio/start.mp3').play();
        }
      } catch (error) {
        console.error('startRecording error:', error);
        store.setWarningInfo({
          message: 'Failed to start recording. Please try again.',
          type: 'error',
          screen: 'recording',
        });
        teardownSessionMixing();
      } finally {
        setIsStartSessionLoading(false);
        _startRecordingInFlight = false;
      }
    },
    [isStartSessionLoading, checkMicrophonePermission]
  );

  // --- Pause Recording ---
  const pauseRecording = useCallback(() => {
    const store = useVoice2RxStore.getState();
    const sessionId = store.sessionV2Ongoing.recording_session_id;
    if (!sessionId) return;

    store.setSessionV2Content(sessionId, { phase: SESSION_PHASE.PAUSED });

    tracker.log({
      name: MIXPANEL_EVENT_NAME.SCRIBEWEB_NEW_SESSION,
      type: MIXPANEL_EVENT_TYPE.PAUSE_RECORDING,
    });

    if (store.playAudioCues) {
      new Audio('/audio/pause.mp3').play();
    }

    try {
      sdkService.pauseRecording();
    } catch (e) {
      console.error('pauseRecording failed:', e);
    }
  }, []);

  // --- Resume Recording ---
  const resumeRecording = useCallback(() => {
    const store = useVoice2RxStore.getState();
    const sessionId = store.sessionV2Ongoing.recording_session_id;
    if (!sessionId) return;

    store.setSessionV2Content(sessionId, { phase: SESSION_PHASE.RECORDING });

    tracker.log({
      name: MIXPANEL_EVENT_NAME.SCRIBEWEB_NEW_SESSION,
      type: MIXPANEL_EVENT_TYPE.RESUME_RECORDING,
    });

    if (store.playAudioCues) {
      new Audio('/audio/pause.mp3').play();
    }

    try {
      sdkService.resumeRecording();
    } catch (e) {
      console.error('resumeRecording failed:', e);
    }
  }, []);

  // --- End Recording ---
  const endRecording = useCallback(async () => {
    if (_endRecordingInFlight) return;

    const store = useVoice2RxStore.getState();
    const sessionId = store.sessionV2Ongoing.recording_session_id;
    if (!sessionId) return;

    const sessionContent = store.sessionV2ContentById[sessionId];
    const phase = sessionContent?.phase;
    if (phase !== SESSION_PHASE.RECORDING && phase !== SESSION_PHASE.PAUSED) return;

    _endRecordingInFlight = true;
    const endRecordingStartMs = Date.now();
    const recordingDurationMs = Math.round((sessionContent?.session_duration ?? 0) * 1000);
    const totalChunks = sessionContent?.uploaded_chunks?.length ?? 0;
    const uploadProgress = sessionContent?.upload_progress;

    teardownSessionMixing();

    if (store.playAudioCues) {
      new Audio('/audio/end.mp3').play();
    }

    store.setSessionV2Content(sessionId, { phase: SESSION_PHASE.PROCESSING });

    tracker.log({
      name: 'chunk_upload_summary',
      properties: {
        session_id: sessionId,
        total_chunks: totalChunks,
        successful_uploads: uploadProgress?.success ?? 0,
        pending_or_failed: totalChunks - (uploadProgress?.success ?? 0),
        recording_duration_ms: recordingDurationMs,
      },
    });

    const perfMemory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    const memoryMb = perfMemory ? Math.round(perfMemory.usedJSHeapSize / 1024 / 1024) : 0;
    const MEMORY_THRESHOLD_MB = 500;
    const LONG_SESSION_MS = 30 * 60 * 1000;
    tracker.log({
      name: 'memory_snapshot',
      properties: {
        session_id: sessionId,
        heap_used_mb: memoryMb,
        recording_duration_ms: recordingDurationMs,
      },
    });
    if (memoryMb > MEMORY_THRESHOLD_MB) {
      tracker.log({
        name: 'high_memory_usage',
        properties: {
          session_id: sessionId,
          heap_used_mb: memoryMb,
          recording_duration_ms: recordingDurationMs,
        },
      });
    }
    if (recordingDurationMs > LONG_SESSION_MS) {
      tracker.log({
        name: 'long_session_ended',
        properties: {
          session_id: sessionId,
          recording_duration_ms: recordingDurationMs,
          heap_used_mb: memoryMb,
          total_chunks: totalChunks,
        },
      });
    }

    try {
      const response = await with401Retry(() => sdkService.endRecording(), 'end recording');

      tracker.log({
        name: MIXPANEL_EVENT_NAME.SCRIBEWEB_NEW_SESSION,
        type: MIXPANEL_EVENT_TYPE.END_RECORDING,
        properties: {
          session_id: sessionId,
          status_code: response.status_code,
          error_code: response.error_code,
        },
      });

      if (response.error_code === ERROR_CODE.AUDIO_UPLOAD_FAILED) {
        store.setSessionV2Content(sessionId, {
          phase: SESSION_PHASE.ERROR,
          error: {
            code: 'upload_failed',
            message: 'Some audio chunks failed to upload.',
            failed_files: response.failed_files,
          },
        });
        return;
      }

      if (response.error_code) {
        store.setSessionV2Content(sessionId, {
          phase: SESSION_PHASE.ERROR,
          error: {
            code: response.error_code,
            message: response.message || 'Failed to end recording.',
          },
        });
        return;
      }

      tracker.log({
        name: 'processing_started',
        properties: {
          session_id: sessionId,
          recording_duration_ms: recordingDurationMs,
          total_chunks: totalChunks,
        },
      });

      // Success — poll for output
      const result = await pollAndLoadSessionDetails(sessionId, SESSION_PHASE.OUTPUT, {
        transcriptFirst: true,
      });

      if (result === 'failed') {
        const processingDurationMs = Date.now() - endRecordingStartMs;
        tracker.log({
          name: 'processing_failed',
          properties: {
            session_id: sessionId,
            message: 'Failed to process data. Please try again.',
            duration_ms: processingDurationMs,
            recording_duration_ms: recordingDurationMs,
            total_chunks: totalChunks,
            failed_chunks: totalChunks - (uploadProgress?.success ?? 0),
            network_online: navigator.onLine,
          },
        });
        tracker.error(new Error('Processing failed'), {
          domain: 'processing',
          component: 'polling',
          extra: {
            session_id: sessionId,
            duration_ms: processingDurationMs,
            recording_duration_ms: recordingDurationMs,
            total_chunks: totalChunks,
            network_online: navigator.onLine,
          },
        });
        store.setSessionV2Content(sessionId, {
          phase: SESSION_PHASE.ERROR,
          error: {
            code: 'processing_failed',
            message: 'Failed to process data. Please try again.',
          },
        });
      } else {
        tracker.log({
          name: 'processing_completed',
          properties: {
            session_id: sessionId,
            duration_ms: Date.now() - endRecordingStartMs,
            recording_duration_ms: recordingDurationMs,
          },
        });
      }
    } catch (e) {
      tracker.log({
        name: 'session_end_failed',
        properties: {
          session_id: sessionId,
          message: 'Failed to end recording. Please try again.',
          total_chunks: totalChunks,
          failed_chunks: totalChunks - (uploadProgress?.success ?? 0),
          recording_duration_ms: recordingDurationMs,
          network_online: navigator.onLine,
        },
      });
      tracker.error(e, {
        domain: 'recording',
        component: 'voice_api',
        tags: { error_code: 'session_end_failed' },
        extra: {
          session_id: sessionId,
          total_chunks: totalChunks,
          recording_duration_ms: recordingDurationMs,
          network_online: navigator.onLine,
        },
      });

      console.error('endRecording failed:', e);

      store.setSessionV2Content(sessionId, {
        phase: SESSION_PHASE.ERROR,
        error: {
          code: 'internal_server_error',
          message: 'Failed to end recording. Please try again.',
        },
      });
    } finally {
      _endRecordingInFlight = false;
    }
  }, []);

  // --- Discard Session ---
  const discardSession = useCallback(
    (targetSessionId?: string) => {
      if (_discardInFlight) return;
      _discardInFlight = true;

      teardownSessionMixing();
      const store = useVoice2RxStore.getState();
      const sessionId = targetSessionId || store.sessionV2Ongoing.recording_session_id;

      if (sessionId) {
        discardAndCleanup(sessionId, () => router.replace('/new-session'));
      }

      _discardInFlight = false;
    },
    [router]
  );

  // --- Stop Processing (abort polling, reset states, redirect) ---
  const stopProcessing = useCallback(() => {
    abortPolling();

    tracker.log({ name: 'stop_processing' });

    const store = useVoice2RxStore.getState();

    store.clearRecordingSessionId();
    store.clearSessionState();
    store.refreshPastSessionsCallback?.();
    router.replace('/new-session');
  }, [router]);

  return {
    createSession,
    loadSession,
    startRecording,
    pauseRecording,
    resumeRecording,
    endRecording,
    discardSession,
    stopProcessing,
    isStartSessionLoading,
  };
}
