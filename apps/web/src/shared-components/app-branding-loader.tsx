'use client';

import { useEffect } from 'react';
import { loadAppBranding, useAppName } from '@/config/app-branding';

// Mounted once in the root layout: fetches the deployment's app name/mode
// and keeps the document title in sync with it.
export default function AppBrandingLoader() {
  const appName = useAppName();

  useEffect(() => {
    loadAppBranding();
  }, []);

  useEffect(() => {
    document.title = appName;
  }, [appName]);

  return null;
}
