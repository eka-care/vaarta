import { HOSTS } from '@/config/hosts';
import {
  getEkaScribeInstance,
  createWorkerBlobUrl,
  type EkaScribeConfig,
} from '@eka-care/ekascribe-ts-sdk';
import type { ErrorEvent } from 'med-scribe-alliance-ts-sdk';
import useVoice2RxStore from '@/store/store';
import { SESSION_PHASE } from '@/constants/enums';
import { tracker } from '@/analytics';
import { getFlavour, getHost, getAuthTokens } from '@/platform';
import { initTransport } from '@/transport';
import { applyRefreshedTokens } from '@/utils/auth-token-sync';
import type { IpcBridge } from '@/transport';

export type EkaScribeSDK = ReturnType<typeof getEkaScribeInstance>;
const env = (process.env.NEXT_PUBLIC_ENV || 'PROD') as 'DEV' | 'PROD';

export interface InitEkaScribeConfig {
  env: 'PROD' | 'DEV';
  flavour?: string;
  mode: 'http' | 'ipc';
  clientId?: string;
  access_token?: string;
  allianceConfig?: {
    baseUrl: string;
    useWorker: boolean;
  };
  bridge?: IpcBridge;
  onTokenRefresh?: () => Promise<string>;
}

export const EKA_SCRIBE_DEFAULT_CONFIG: InitEkaScribeConfig = {
  env,
  flavour: getFlavour(),
  mode: 'http',
  allianceConfig: {
    baseUrl: HOSTS.ALLIANCE_BASE_URL,
    useWorker: getHost() === 'web',
  },
};

let sdkInstance: EkaScribeSDK | null = null;
let initPromise: Promise<void> | null = null;
let currentInitConfig: InitEkaScribeConfig = EKA_SCRIBE_DEFAULT_CONFIG;
let sharedWorkerUrl: string | undefined;

// Cookies-first with 401 self-heal: onTokenRequired returns a fresh bearer on desktop
function createInstance() {
  if (sdkInstance) return;

  const cfg = currentInitConfig;

  const sdkConfig: EkaScribeConfig = {
    env: cfg.env,
    flavour: cfg.flavour,
    mode: cfg.mode,
    clientId: cfg.clientId,
    allianceConfig: cfg.allianceConfig,
    access_token: cfg.access_token,
    ...(cfg.bridge ? { ipcBridge: cfg.bridge } : {}),
    ...(sharedWorkerUrl ? { sharedWorkerUrl } : {}),
  };

  sdkInstance = getEkaScribeInstance(sdkConfig);

  sdkInstance.registerCallback('onTokenRequired', async () => {
    const sessionId = useVoice2RxStore.getState().sessionV2Ongoing.recording_session_id;
    tracker.log({
      name: 'sdk_token_refresh',
      properties: { session_id: sessionId, host: getHost() },
    });
    if (getHost() === 'desktop') {
      const tokens = await getAuthTokens()?.refresh();
      if (tokens?.accessToken) {
        await applyRefreshedTokens(tokens);
        return tokens.accessToken;
      }
      tracker.error(new Error('SDK token refresh failed'), {
        domain: 'auth',
        component: 'sdk',
        extra: { session_id: sessionId },
      });
    }
    return cfg.access_token ?? '';
  });

  sdkInstance.registerCallback('onError', (event: ErrorEvent) => {
    const errorCode = event.error?.code;
    const store = useVoice2RxStore.getState();
    const sessionId = store.sessionV2Ongoing.recording_session_id;

    tracker.error(new Error(`SDK Error: ${errorCode} - ${event.error?.message}`), {
      domain: 'recording',
      component: 'SDKProvider',
      tags: { error_code: String(errorCode ?? 'unknown') },
      extra: { network_online: navigator.onLine, session_id: sessionId ?? undefined },
    });

    if (!sessionId) return;

    if (errorCode === 'chunk_limit_reached') {
      tracker.log({
        name: 'chunk_limit_reached',
        properties: { session_id: sessionId },
      });
      store.setSessionV2Content(sessionId, {
        phase: SESSION_PHASE.ERROR,
        error: {
          code: 'chunk_limit_reached',
          message: 'Please end recording or continue if you want to record more.',
        },
      });
      return;
    }

    if (errorCode === 'chunk_length_exceeded') {
      tracker.log({
        name: 'chunk_length_exceeded',
        properties: { session_id: sessionId },
      });
      store.setWarningInfo({
        message: 'A small portion of audio was corrupted and has been skipped.',
        screen: 'recording',
      });
      return;
    }
  });
}

/**
 * Single entry point — initializes transport + EkaScribe SDK.
 * Call once at app startup before any API calls.
 */
export async function initEkaScribe(config: InitEkaScribeConfig) {
  sdkInstance = null;
  initPromise = null;
  currentInitConfig = config;

  // Set up transport based on mode
  if (config.mode === 'ipc' && config.bridge) {
    initTransport({
      mode: 'ipc',
      bridge: config.bridge,
      accessToken: config.access_token || '',
      onTokenRefresh: config.onTokenRefresh,
    });
  } else {
    initTransport({ mode: 'http' });
  }

  initPromise = (async () => {
    try {
      const workerUrl = await createWorkerBlobUrl(
        HOSTS.MSA_WORKER_URL // self-hosted (public/msa/) — no jsDelivr at runtime
      );
      if (workerUrl) {
        sharedWorkerUrl = workerUrl;
      }
    } catch {
      tracker.log({ name: 'shared_worker_creation_failed' });
    }
    createInstance();
  })();

  return initPromise;
}

/**
 * Sync getter — if initEkaScribe hasn't been awaited yet, creates instance
 * synchronously without shared worker (main-thread uploads as fallback).
 */
export function getSDK(): EkaScribeSDK {
  if (!sdkInstance) createInstance();
  return sdkInstance!;
}
