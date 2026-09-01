import setEnv from '@/fetch-client/helper';
import type { AuthTokens } from '@/platform/contracts';

// The SDK holds its own access token, so a refresh must reach it or the retry re-sends the stale one.
export async function applyRefreshedTokens(tokens: AuthTokens): Promise<void> {
  setEnv({ auth_token: tokens.accessToken, refresh_token: tokens.refreshToken });

  // Lazy: sdk-provider imports fetch-client/helper at module load.
  try {
    const { getSDK } = await import('@/features/session/services/sdk-provider');
    getSDK().updateAuthTokens({ access_token: tokens.accessToken });
  } catch (error) {
    console.error('Failed to propagate refreshed token to the SDK', error);
  }
}
