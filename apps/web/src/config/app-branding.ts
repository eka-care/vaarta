// Deployment branding + product mode, served at runtime by the backend
// (GET /connect-auth/v1/auth-mode → app_name / app_mode) so one static
// bundle works for every deployment. Defaults apply until the fetch lands.
import { useSyncExternalStore } from 'react';

export type AppMode = 'general' | 'medical';

export type AppBranding = {
  appName: string;
  appMode: AppMode;
};

const DEFAULT_BRANDING: AppBranding = { appName: 'Vaarta', appMode: 'general' };

let branding: AppBranding = DEFAULT_BRANDING;
const listeners = new Set<() => void>();
let loadPromise: Promise<AppBranding> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

export function setAppBranding(info: { app_name?: unknown; app_mode?: unknown }) {
  const appName =
    typeof info?.app_name === 'string' && info.app_name.trim()
      ? info.app_name.trim()
      : DEFAULT_BRANDING.appName;
  const appMode: AppMode = info?.app_mode === 'medical' ? 'medical' : 'general';
  if (appName === branding.appName && appMode === branding.appMode) return;
  branding = { appName, appMode };
  emit();
}

export function getAppBranding(): AppBranding {
  return branding;
}

export function getAppName(): string {
  return branding.appName;
}

// Fetches once per page load; callers that already hold an auth-mode
// response (the login page) call setAppBranding directly instead.
export function loadAppBranding(): Promise<AppBranding> {
  if (!loadPromise) {
    loadPromise = fetch('/connect-auth/v1/auth-mode', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        if (info) setAppBranding(info);
        return branding;
      })
      .catch(() => branding);
  }
  return loadPromise;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppBranding(): AppBranding {
  return useSyncExternalStore(subscribe, getAppBranding, () => DEFAULT_BRANDING);
}

export function useAppName(): string {
  return useAppBranding().appName;
}

export function useAppMode(): AppMode {
  return useAppBranding().appMode;
}
