'use client';

import { useAppName } from '@/config/app-branding';

// Renders the deployment's app name; usable from server components.
export default function AppName() {
  return <>{useAppName()}</>;
}
