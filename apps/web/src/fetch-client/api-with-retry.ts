import { refreshToken } from './index';
import { notifyAuthDead } from '@/utils/auth-failure';

// Our three response shapes: ekascribe transport, legacy `code`, and alliance SDKResult.
function authStatusOf(response: unknown): number | undefined {
  if (!response || typeof response !== 'object') return undefined;

  const shape = response as {
    status_code?: number;
    code?: number;
    error?: { httpStatus?: number };
  };
  return shape.status_code ?? shape.code ?? shape.error?.httpStatus;
}

export async function with401Retry<T>(
  apiCall: () => Promise<T>,
  apiName: string
): Promise<T> {
  const response = await apiCall();
  const status = authStatusOf(response);

  if (status === 403) {
    notifyAuthDead();
    return response;
  }

  if (status !== 401) return response;

  const refreshed = await refreshToken();
  if (!refreshed) {
    notifyAuthDead();
    return response;
  }

  const retried = await apiCall();
  if (authStatusOf(retried) === 401) {
    console.warn(`Still unauthorized after refresh: ${apiName}`);
    notifyAuthDead();
  }
  return retried;
}
