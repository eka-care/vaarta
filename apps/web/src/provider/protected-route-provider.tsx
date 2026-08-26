'use client';

import { useRouter, usePathname } from 'next/navigation';

import useVoice2RxStore from '@/store/store';
import { getStorage } from '@/platform';
import {
  handleUserClearStoreAfterLogout,
  handleUserLogout,
} from '@/utils/user-auth-logout-utility-methods';
import { useCallback, useEffect, useRef } from 'react';
import useGetWhoAmI from '@/shared-hooks/use-get-who-am-i';
import UIHydrationComponent from '@/shared-components/ui-hydration-component';
import OfflineScreen from '@/shared-components/offline-screen';
import useOnlineStatus from '@/shared-hooks/use-online-status';
import {
  fetchLatestSessionId,
  loadSessionDetails,
} from '@/features/session/services/session-loader';

type Props = {
  children: React.ReactNode;
};

// Routes that render without authentication — no whoami fetch or gating.
const PUBLIC_ROUTES = ['/ekascribe', '/auth', '/download', '/tutorial'];

const isPublicRoute = (pathname: string): boolean =>
  PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(route + '/'));

const ProtectedRouteProvider = ({ children }: Props) => {
  const pathname = usePathname();

  // Public routes skip auth entirely — the guard (and its whoami hook) never mounts.
  if (isPublicRoute(pathname)) return <>{children}</>;

  return <ProtectedRouteGuard>{children}</ProtectedRouteGuard>;
};

const ProtectedRouteGuard = ({ children }: Props) => {
  const router = useRouter();
  const pathname = usePathname();

  const {
    data: loggedInUserData,
    isLoading: isLoadingWhoAmI,
    isError: isWhoAmIError,
    refetch: refetchWhoAmI,
  } = useGetWhoAmI();
  const isOnline = useOnlineStatus();

  const loggedInUserUuid = loggedInUserData?.uuid;

  const onUserLogout = useCallback(async () => {
    await handleUserLogout();
  }, []);

  // Resolve the '/' landing only once.
  const entryResolvedRef = useRef(false);

  // Effect 1: Handle user authentication and identity changes
  useEffect(() => {
    if (isLoadingWhoAmI) return;

    // No identity — if offline or whoami errored, don't log out (show offline screen instead).
    if (!loggedInUserUuid) {
      if (isWhoAmIError || !isOnline) return;
      onUserLogout();
      return;
    }

    const storedUserUuid = getStorage().session.get('ekascribe-user-uuid');

    // First load in this tab — record identity.
    if (!storedUserUuid) {
      getStorage().session.set('ekascribe-user-uuid', loggedInUserUuid);
      return;
    }

    // Identity changed for this tab (e.g. logout + relogin elsewhere) →
    // clear the stale store and reload to re-initialise.
    if (storedUserUuid !== loggedInUserUuid) {
      handleUserClearStoreAfterLogout();
      getStorage().session.set('ekascribe-user-uuid', loggedInUserUuid);
      const queryString = new URLSearchParams(window.location.search).toString();
      window.location.href = queryString ? `/?${queryString}` : '/';
    }
  }, [loggedInUserUuid, isLoadingWhoAmI, isWhoAmIError, isOnline]);

  // Effect 2: the single redirect authority. Users landing on '/' resume their
  // current session, else open the latest, else start fresh.
  useEffect(() => {
    if (isLoadingWhoAmI) return;
    if (!loggedInUserUuid) return;

    if (pathname === '/' && !entryResolvedRef.current) {
      entryResolvedRef.current = true;
      (async () => {
        if (useVoice2RxStore.getState().sessionV2Ongoing.recording_session_id) {
          router.replace('/new-session');
          return;
        }
        const latestId = await fetchLatestSessionId();
        if (latestId) {
          await loadSessionDetails(latestId);
          router.replace(`/session/${latestId}` as any);
        } else {
          router.replace('/new-session');
        }
      })();
    }
  }, [loggedInUserUuid, pathname, router, isLoadingWhoAmI]);

  if (!isLoadingWhoAmI && !loggedInUserUuid && (isWhoAmIError || !isOnline)) {
    return <OfflineScreen onRetry={refetchWhoAmI} />;
  }

  // Store hydration is already guaranteed by ScreenContainer; wait only on auth data here.
  const shouldShowLoading = isLoadingWhoAmI;

  if (shouldShowLoading) {
    return <UIHydrationComponent />;
  }

  return children;
};

export default ProtectedRouteProvider;
