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
import { ERROR_CODE, type PatientDetails } from '@eka-care/ekascribe-ts-sdk';
import type { PartnerContext } from '@/features/partner-session/types';
import { getSDK } from '../services/sdk-provider';
import { discardAndCleanup } from '../utils/discard-session';

function teardownSessionMixing() {
  getPlatform().audioCapture?.teardownSessionMixing?.();
}

// The STT backend accepts explicit codes only (InputLanguage: en, hi, en-hi, en-IN,
// gu, kn, ml, ta, te, bn, mr, pa) and does no auto-detection — discovery reports
// auto_detection: false. 'auto_detect' is a client-side preference id with no API
// equivalent: sent as-is the server resolves it to None, drops it, and rejects the
// create with "language_hint is required on session create". Code-mixed en-hi is the
// closest behaviour the backend offers, so that is what it becomes on the wire.
// The original ids are kept for the UI — only the API payload is translated.
const AUTO_DETECT_ID = 'auto_detect';
const AUTO_DETECT_API_EQUIVALENT = 'en-hi';
// An empty language_hint is always a 400 ("language_hint is required on session
// create"). That happens whenever the session is created before the user's
// preferences have loaded — a partner popup opened from another origin gets a
// fresh sessionStorage, so the persisted store starts empty. Send a valid floor
// rather than an empty array; a real preference always overrides it.
const FALLBACK_API_LANGUAGE = 'en-IN';

function toApiLanguageCodes(ids: string[]): string[] {
  const mapped = ids.map((id) => (id === AUTO_DETECT_ID ? AUTO_DETECT_API_EQUIVALENT : id));
  const codes = Array.from(new Set(mapped.filter(Boolean)));
  return codes.length > 0 ? codes : [FALLBACK_API_LANGUAGE];
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
      session_id,
      templates,
      language_hint,
      patient_details,
      title,
      partner_additional_data,
      partner_context,
    }: {
      templates?: string[];
      encounter_id?: string;
      upload_type?: 'chunked' | 'single';
      // Bypass the reuse guard to replace a stale pointer with a fresh session.
      force?: boolean;
      // Partner handoff: pins the session id and overrides defaults for this session only.
      session_id?: string;
      language_hint?: string[];
      patient_details?: PatientDetails;
      /** Partner-set session title — lands in session_details.title, editable by the doctor. */
      title?: string;
      /** Remaining partner additional_data keys (attendees, …), merged into the session's own. */
      partner_additional_data?: Record<string, unknown>;
      partner_context?: PartnerContext;
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
        const sessionId = session_id || 'sc-' + uuidv4().replace(/-/g, '').slice(0, 28);
        const createStartMs = Date.now();

        try {
          const { userLevelPreferences, appConfig, templateNameById } =
            useVoice2RxStore.getState();

          // Snapshot the user's defaults as this session's own config. New sessions always start from default config.
          // A partner handoff overrides them; ids resolve to names via the cached lookups.
          const inputLanguages = language_hint
            ? language_hint.map((id) => ({
                id,
                name: appConfig.supported_languages.find((lang) => lang.id === id)?.name || id,
              }))
            : userLevelPreferences.input_languages;
          const outputFormatTemplates = templates
            ? templates.map((id) => ({ id, name: templateNameById[id] || '' }))
            : userLevelPreferences.output_format_template;

          const newSessionConfig = {
            input_languages: inputLanguages,
            output_format_template: outputFormatTemplates,
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

          const inputLanguage = toApiLanguageCodes(inputLanguages.map((l) => l.id));
          const outputTemplates = outputFormatTemplates.map((t) => t.id);
          const systemInfo = await getSystemInfo();

          // Also mirrored into the store below: the session PATCH replaces
          // additional_data wholesale, so title edits must merge against this.
          const additionalData = {
            model_training_consent: userLevelPreferences.model_training_consent.value,
            system_info: systemInfo,
            ...(encounter_id ? { encounter_id } : {}),
            ...(partner_additional_data ?? {}),
            ...(partner_context ? { partner_context } : {}),
            _flavour: getFlavour(),
            input_languages: inputLanguages,
            output_format_template: outputFormatTemplates,
            model_type: 'pro',
            consultation_mode: 'dictation',
          };

          const createSessionBody = {
            session_id: sessionId,
            templates: outputTemplates,
            language_hint: inputLanguage,
            model: 'pro',
            transcript_language: userLevelPreferences.output_language || 'en-IN',
            upload_type,
            communication_protocol: 'http',
            session_mode: 'dictation',
            ...(patient_details ? { patient_details } : {}),
            additional_data: additionalData,
          };

          if (partner_context) {
            console.log('[partner-session] 3. POSTED TO API  POST /voice/v1/sessions?version=v2', {
              body: createSessionBody,
              note: 'fields the API schema does not declare are dropped server-side',
            });
          }

          const response = await with401Retry(
            () => sdkService.createSession(createSessionBody, 'v2'),
            'create session'
          );

          if (partner_context) {
            console.log('[partner-session] 3b. API REPLIED', {
              success: response.success,
              session_id: response.success ? response.data?.session_id : undefined,
              error: response.success ? undefined : response.error,
            });
          }

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

          // A partner-supplied title goes the same route the doctor's own title
          // edits take: session_details on PATCH. The create route ignores
          // session_details entirely, so setting it in the create body is a no-op.
          const partnerTitle = title?.trim();
          if (partnerTitle) {
            const nextDetails = { title: partnerTitle };
            store.setSessionV2Content(session_id, { session_details: nextDetails });
            with401Retry(
              () =>
                getSDK().sessions.patchSessionStatus(
                  { session_details: nextDetails } as unknown as Parameters<
                    ReturnType<typeof getSDK>['sessions']['patchSessionStatus']
                  >[0],
                  session_id
                ),
              'patch partner session title'
            ).catch(() => {});
          }

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

    const audioDurationSeconds = Math.round(sessionContent?.session_duration ?? 0);
    if (audioDurationSeconds > 0) {
      const mergedAdditionalData = {
        ...(sessionContent?.additional_data ?? {}),
        audio_duration: audioDurationSeconds,
      };
      store.setSessionV2Content(sessionId, { additional_data: mergedAdditionalData });
      with401Retry(
        () =>
          getSDK().sessions.patchSessionStatus(
            { additional_data: mergedAdditionalData },
            sessionId
          ),
        'patch audio duration'
      ).catch(() => {});
    }

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
