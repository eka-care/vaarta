export const FLAVOUR = 'ekascribe-web';

import { HOSTS } from '@/config/hosts';

// Same-origin relative URLs (see src/config/hosts.ts).
export const LOGOUT_PROD_URL = HOSTS.LOGIN_URL;
export const LOGOUT_DEV_URL = HOSTS.LOGIN_URL;

export const SWITCH_WORKSPACE_PROD_URL = HOSTS.SWITCH_WORKSPACE_URL;
export const SWITCH_WORKSPACE_DEV_URL = HOSTS.SWITCH_WORKSPACE_URL;

export const MAC_APP_DOWNLOAD_URL =
  'https://vaarta.bharatai.gov.in/artifacts/channels/stable/download/mac';
export const WINDOWS_APP_DOWNLOAD_URL =
  'https://vaarta.bharatai.gov.in/artifacts/channels/stable/download/win';

