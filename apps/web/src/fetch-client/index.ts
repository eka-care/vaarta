import { GET_CLIENT_ID, GET_EKA_HOST, GET_AUTH_TOKEN } from './helper';
import { getTransport } from '@/transport';
import { getHost, getAuthTokens } from '@/platform';
import { notifyAuthDead } from '@/utils/auth-failure';
import { applyRefreshedTokens } from '@/utils/auth-token-sync';
import { tracker } from '@/analytics';

function classifyService(url: string): string {
  if (url.includes('.amazonaws.com')) return 's3';
  if (url.includes('/voice/api/v2') || url.includes('/voice/api/v3') || url.includes('/voice/v1')) return 'voice_api';
  if (url.includes('/connect-auth/')) return 'connect_auth';
  return 'unknown';
}

function extractEndpoint(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function refreshToken(): Promise<boolean> {
  if (getHost() === 'desktop') {
    try {
      const tokens = await getAuthTokens()?.refresh();
      if (!tokens?.accessToken) return false;

      await applyRefreshedTokens(tokens);
      return true;
    } catch {
      return false;
    }
  }

  // Web: cookie-based refresh endpoint
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'client-id': GET_CLIENT_ID(),
    };

    const response = await getTransport().request(
      `${GET_EKA_HOST()}/connect-auth/v1/account/refresh-token`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
        credentials: 'include',
      }
    );

    // Cookies are set by the response itself, so there is no token to propagate.
    return response.ok;
  } catch {
    return false;
  }
}

export default async function fetchWrapper(
  url: RequestInfo,
  options: RequestInit | undefined = {},
  retry: boolean = true
) {
  const urlString = typeof url === 'string' ? url : (url as Request).url;
  const method = options.method?.toUpperCase() || 'GET';
  const startMs = Date.now();

  try {
    const newHeaders = new Headers(options.headers);

    if (!newHeaders.get('client-id')) {
      newHeaders.set('client-id', GET_CLIENT_ID());
    }

    // Desktop: inject the host-seeded Bearer token instead of relying on cookies
    if (getHost() === 'desktop') {
      const token = GET_AUTH_TOKEN();
      if (token && !newHeaders.get('authorization')) {
        newHeaders.set('Authorization', `Bearer ${token}`);
      }
    }

    // Convert Headers to plain object for transport compatibility
    const headerRecord: Record<string, string> = {};
    newHeaders.forEach((value, key) => {
      headerRecord[key] = value;
    });

    const response = await getTransport().request(urlString, {
      ...options,
      headers: headerRecord,
      credentials: 'include',
    });

    const durationMs = Date.now() - startMs;

    if (response.status === 401 && retry) {
      const refreshSuccess = await refreshToken();

      if (refreshSuccess) {
        return await fetchWrapper(url, options, false);
      }

      notifyAuthDead();
      throw new Error('Unable to refresh user token');
    }

    if (response.status >= 400) {
      tracker.error(new Error(`API call failed: ${method} ${extractEndpoint(urlString)} ${response.status}`), {
        domain: 'api',
        component: classifyService(urlString),
        extra: {
          endpoint: extractEndpoint(urlString),
          method,
          status_code: response.status,
          duration_ms: durationMs,
          is_retry: !retry,
        },
      });
    } else if (durationMs > 5000) {
      tracker.log({
        name: 'slow_api_call',
        properties: {
          endpoint: extractEndpoint(urlString),
          method,
          status_code: response.status,
          duration_ms: durationMs,
          service: classifyService(urlString),
        },
      });
    }

    return response;
  } catch (error) {
    const durationMs = Date.now() - startMs;
    tracker.error(error, {
      domain: 'api',
      component: classifyService(urlString),
      extra: {
        endpoint: extractEndpoint(urlString),
        method,
        status_code: 0,
        duration_ms: durationMs,
        is_retry: !retry,
        error_message: error instanceof Error ? error.message : String(error),
      },
    });
    console.error(error);
    throw error;
  }
}

export { refreshToken };
