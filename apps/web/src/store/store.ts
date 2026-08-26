import { create } from 'zustand';
import TStore from './types';
import { TAppConfig, TUserSelectedPreferences } from '@/constants/types';
import { MODEL_TYPE, SESSION_PHASE } from '@/constants/enums';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { getStorage } from '@/platform';
import { TUTORIAL_CARD_DISMISSED_KEY, TUTORIAL_HINT_PENDING_KEY } from '@/constants/tutorial';
import type {
  SessionV2Ongoing,
  SessionV2Content,
  SessionV2UiState,
  NormalizedDocument,
} from '@/features/session/types';

export const emptySessionV2Ongoing: SessionV2Ongoing = {
  recording_session_id: '',
};

const emptySessionV2UiState = {
  loading: false,
  poll_status: 'idle' as const,
  selected_tab: 'context',
  selected_transcript_lang: '',
  save_status_by_doc: {} as Record<string, 'idle' | 'typing' | 'synced' | 'error'>,
  last_synced_at: 0,
  is_template_processing: false,
  transcript_loading: {} as Record<string, boolean>,
  pending_paste_scroll_doc_id: null as SessionV2UiState['pending_paste_scroll_doc_id'],
  pending_reload_doc_id: null as SessionV2UiState['pending_reload_doc_id'],
};

export const emptySessionV2Content: SessionV2Content = {
  phase: SESSION_PHASE.IDLE,
  error: null,
  is_limit_exceeded: false,
  created_at: '',
  upload_url: {},
  expires_at: '',
  session_duration: 0,
  audio_amplitudes: [],
  is_speaking: false,
  chunk_transcripts: {},
  uploaded_chunks: [],
  upload_progress: { success: 0, total: 0 },
  audio_matrix: null,
  additional_data: {},
  session_details: {},
  session_config: null,
  session_context: {},
  user_status: '',
  context: [],
  transcript: [],
  documents: [],
  ui: emptySessionV2UiState,
};

export const emptyUserSelectedPreferences: TUserSelectedPreferences = {
  input_languages: [],
  output_language: '',
  output_format_template: [],
  consultation_mode: '',
  use_audio_cues: false,
  auto_download: false,
  auto_detect_language: false,
  model_type: MODEL_TYPE.PRO,
  model_training_consent: { value: true, editable: false },
};

// The ongoing session only. Excludes sessionV2ContentById so discard/stop keep loaded sessions.
const sessionInitialState = {
  sessionV2Ongoing: emptySessionV2Ongoing,
  newSessionId: '',
  autoStartRecording: false,
  warningMessage: undefined,
  warningIcon: undefined,
  warningAction: undefined,
  warningListHeader: undefined,
  warningListItems: undefined,
  warningType: undefined,
  warningScreen: undefined,
};

// Banners and template-editor scratch — reset on logout only.
const transientUiInitialState = {
  templateData: null,
  templateAction: 'create' as TStore['templateAction'],
  bannerTitle: undefined,
  bannerSubtitle: undefined,
  bannerActionComponent: undefined,
  bannerTimeout: undefined,
  showBannerCrossIcon: true,
  showForAllUsers: true,
};

// Identity, preferences and cached account data — reset on logout only.
const userInitialState = {
  workspaceID: '',
  appConfig: {
    supported_languages: [],
    supported_models: [],
    output_template_formats: [],
    consultation_modes: [],
    max_selection: {
      supported_languages: 2,
      supported_output_formats: 1,
      consultation_modes: 1,
    },
  } as TAppConfig,
  userLevelPreferences: emptyUserSelectedPreferences,
  userRegion: null,
  loggedInUserDetails: null,
  userSelectedTemplatesList: [] as TStore['userSelectedTemplatesList'],
  templateNameById: {} as TStore['templateNameById'],
  selectedMicrophone: null,
  // null == let the backend fall back to its env default model
  structuringModel: null as string | null,
  playAudioCues: false,
  // Read straight from local storage: the persisted store is sessionStorage-backed, but a
  // tutorial dismissal has to survive restarts.
  tutorialCardDismissed: getStorage().local.get(TUTORIAL_CARD_DISMISSED_KEY) === 'true',
  tutorialHintPending: getStorage().local.get(TUTORIAL_HINT_PENDING_KEY) === 'true',
  // Stale closures over the previous user's components — must not outlive a logout.
  refreshPastSessionsCallback: null,
  refreshLoggedInUserDetailsPromise: null,
};

// Single source of truth: spread into the initializer AND what clearStore resets to.
const storeInitialState = {
  ...sessionInitialState,
  ...transientUiInitialState,
  ...userInitialState,
  sessionV2ContentById: {} as Record<string, SessionV2Content>,
};

// Only these survive a page refresh (sessionStorage). Everything else — transient UI,
// template-editor scratch, derived/refetched data, callbacks — resets to its initial value on rehydrate.
const PERSISTED_KEYS = [
  'workspaceID',
  'appConfig',
  'userLevelPreferences',
  'userRegion',
  'loggedInUserDetails',
  'userSelectedTemplatesList',
  'templateNameById',
  'selectedMicrophone',
  'structuringModel',
  'sessionV2Ongoing',
  'newSessionId',
  'sessionV2ContentById',
  // Keyed off storeInitialState, not TStore, so nothing persisted can survive a logout.
] as const satisfies readonly (keyof typeof storeInitialState)[];

// Session-scoped backend for the persisted store, routed through the platform storage
// capability instead of touching `sessionStorage` directly.
const sessionStateStorage: StateStorage = {
  getItem: (name) => getStorage().session.get(name),
  setItem: (name, value) => getStorage().session.set(name, value),
  removeItem: (name) => getStorage().session.remove(name),
};

const useVoice2RxStore = create<TStore>()(
  persist(
    (set, get) => ({
      ...storeInitialState,

      setWorkspaceID: (workspaceID) => set({ workspaceID }),

      setAppConfig: (config: TAppConfig) => set({ appConfig: config }),

      setUserLevelPreferences: (settings: TUserSelectedPreferences) =>
        set({ userLevelPreferences: settings }),

      setPlayAudioCues: (playAudioCues) => set({ playAudioCues }),

      dismissTutorialCard: () => {
        if (get().tutorialCardDismissed) return;
        const storage = getStorage().local;
        storage.set(TUTORIAL_CARD_DISMISSED_KEY, 'true');
        storage.set(TUTORIAL_HINT_PENDING_KEY, 'true');
        set({ tutorialCardDismissed: true, tutorialHintPending: true });
      },

      acknowledgeTutorialHint: () => {
        getStorage().local.remove(TUTORIAL_HINT_PENDING_KEY);
        set({ tutorialHintPending: false });
      },

      setWarningInfo: (warningInfo) =>
        set({
          warningMessage: warningInfo.message,
          warningIcon: warningInfo.Icon,
          warningAction: warningInfo.ActionComponent,
          warningListHeader: warningInfo.listHeader,
          warningListItems: warningInfo.listItems,
          warningType: warningInfo.type,
          warningScreen: warningInfo.screen,
        }),

      clearWarningInfo: () =>
        set({
          warningMessage: undefined,
          warningIcon: undefined,
          warningAction: undefined,
          warningListHeader: undefined,
          warningListItems: undefined,
          warningType: undefined,
          warningScreen: undefined,
        }),

      setTemplateData: (data) => set({ templateData: data }),

      setUserSelectedTemplatesList: (list) => set({ userSelectedTemplatesList: list }),

      setTemplateNameById: (map) => set({ templateNameById: map }),

      setTemplateAction: (action) => set({ templateAction: action }),

      setLoggedInUserDetails: (user) => set({ loggedInUserDetails: user }),

      setUserRegion: (region) => set({ userRegion: region }),

      setSelectedMicrophone: (microphone) => set({ selectedMicrophone: microphone }),
      setStructuringModel: (model: string | null) => set({ structuringModel: model }),

      setRefreshPastSessionsCallback: (refreshFn) =>
        set({ refreshPastSessionsCallback: refreshFn }),

      setRefreshLoggedInUserDetailsPromise: (refreshFn) =>
        set({ refreshLoggedInUserDetailsPromise: refreshFn }),

      setBannerInfo: (bannerInfo) =>
        set({
          bannerTitle: bannerInfo.title,
          bannerSubtitle: bannerInfo.subtitle,
          bannerActionComponent: bannerInfo.ActionComponent,
          showBannerCrossIcon: bannerInfo.showBannerCrossIcon,
          bannerTimeout: bannerInfo.bannerTimeout,
          showForAllUsers: bannerInfo.showForAllUsers,
        }),

      clearBannerInfo: () =>
        set({
          bannerTitle: undefined,
          bannerSubtitle: undefined,
          bannerActionComponent: undefined,
          bannerTimeout: undefined,
          showBannerCrossIcon: true,
          showForAllUsers: true,
        }),

      setAutoStartRecording: (value) => set({ autoStartRecording: value }),

      // --- V2 Session State ---
      // `newSessionId` drives the "Current Session" card independently of
      // history-list membership (which a refetch can change).
      setNewSessionId: (sessionId) => set({ newSessionId: sessionId }),
      setRecordingSessionId: (sessionId) =>
        set({ sessionV2Ongoing: { recording_session_id: sessionId } }),
      clearRecordingSessionId: () => set({ sessionV2Ongoing: emptySessionV2Ongoing }),

      setSessionV2Content: (sessionId, data) =>
        set((state) => {
          const prev = state.sessionV2ContentById[sessionId] || emptySessionV2Content;
          const next = typeof data === 'function' ? data(prev) : { ...prev, ...data };
          return {
            sessionV2ContentById: {
              ...state.sessionV2ContentById,
              [sessionId]: next,
            },
          };
        }),

      setSessionV2Document: (sessionId, documentId, data) =>
        set((state) => {
          const session = state.sessionV2ContentById[sessionId];
          if (!session) return state;

          const updateDocs = (docs: NormalizedDocument[]) =>
            docs.map((d) => (d.document_id === documentId ? { ...d, ...data } : d));

          return {
            sessionV2ContentById: {
              ...state.sessionV2ContentById,
              [sessionId]: {
                ...session,
                context: updateDocs(session.context),
                transcript: updateDocs(session.transcript),
                documents: updateDocs(session.documents),
              },
            },
          };
        }),

      addSessionV2Document: (sessionId, document) =>
        set((state) => {
          const session = state.sessionV2ContentById[sessionId];
          if (!session) return state;

          const bucket =
            document.document_type === 'context'
              ? 'context'
              : document.document_type === 'transcript'
              ? 'transcript'
              : 'documents';

          return {
            sessionV2ContentById: {
              ...state.sessionV2ContentById,
              [sessionId]: {
                ...session,
                [bucket]: [...session[bucket], document],
              },
            },
          };
        }),

      removeSessionV2Document: (sessionId, documentId) =>
        set((state) => {
          const session = state.sessionV2ContentById[sessionId];
          if (!session) return state;

          const removeDocs = (docs: NormalizedDocument[]) =>
            docs.filter((d) => d.document_id !== documentId);

          return {
            sessionV2ContentById: {
              ...state.sessionV2ContentById,
              [sessionId]: {
                ...session,
                context: removeDocs(session.context),
                transcript: removeDocs(session.transcript),
                documents: removeDocs(session.documents),
              },
            },
          };
        }),

      setSessionV2Ui: (sessionId, data) =>
        set((state) => {
          const session = state.sessionV2ContentById[sessionId];
          if (!session) return state;
          return {
            sessionV2ContentById: {
              ...state.sessionV2ContentById,
              [sessionId]: {
                ...session,
                ui: { ...session.ui, ...data },
              },
            },
          };
        }),

      setTranscriptLangLoading: (sessionId, lang, loading) =>
        set((state) => {
          const session = state.sessionV2ContentById[sessionId];
          if (!session) return state;

          return {
            sessionV2ContentById: {
              ...state.sessionV2ContentById,
              [sessionId]: {
                ...session,
                ui: {
                  ...session.ui,
                  transcript_loading: {
                    ...session.ui.transcript_loading,
                    [lang]: loading,
                  },
                },
              },
            },
          };
        }),

      setDocSaveStatus: (sessionId, docKey, status) =>
        set((state) => {
          const session = state.sessionV2ContentById[sessionId];
          if (!session) return state;
          return {
            sessionV2ContentById: {
              ...state.sessionV2ContentById,
              [sessionId]: {
                ...session,
                ui: {
                  ...session.ui,
                  save_status_by_doc: {
                    ...session.ui.save_status_by_doc,
                    [docKey]: status,
                  },
                },
              },
            },
          };
        }),

      clearSessionV2Content: (sessionId) =>
        set((state) => {
          const { [sessionId]: _, ...rest } = state.sessionV2ContentById;
          return { sessionV2ContentById: rest };
        }),

      // Discard / stop-processing / unload — stays signed in, keeps loaded sessions.
      clearSessionState: () => set({ ...sessionInitialState }),

      // Logout — full wipe so nothing reaches the next user.
      clearStore: () => set({ ...storeInitialState }),
    }),
    {
      name: 'ekascribe-ai-store',
      storage: createJSONStorage(() => sessionStateStorage),
      partialize: (state) =>
        Object.fromEntries(PERSISTED_KEYS.map((key) => [key, state[key]])) as Pick<
          TStore,
          (typeof PERSISTED_KEYS)[number]
        >,
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        for (const [sessionId, content] of Object.entries(state.sessionV2ContentById)) {
          // Reset transient per-document UI status
          let next = {
            ...content,
            ui: {
              ...content.ui,
              loading: false,
              poll_status: 'idle' as const,
              save_status_by_doc: {},
              is_template_processing: false,
              transcript_loading: {},
              pending_paste_scroll_doc_id: null,
              pending_reload_doc_id: null,
            },
          };

          // Reset transient recording state on rehydrate — a page refresh means the
          // recording was lost, so clean up stale runtime fields.
          const { phase } = content;
          if (
            phase === SESSION_PHASE.RECORDING ||
            phase === SESSION_PHASE.PAUSED ||
            phase === SESSION_PHASE.PROCESSING
          ) {
            next = {
              ...next,
              phase: SESSION_PHASE.IDLE,
              session_duration: 0,
              audio_amplitudes: [],
              is_speaking: false,
              chunk_transcripts: {},
              uploaded_chunks: [],
              upload_progress: { success: 0, total: 0 },
            };
          }

          state.sessionV2ContentById[sessionId] = next;
        }
      },
    }
  )
);

export default useVoice2RxStore;
