'use client';

import VaartaAnimatedLogo from '@/assets/vaarta-animated-logo';
import { useAppName } from '@/config/app-branding';

const UIHydrationComponent = () => {
  const appName = useAppName();
  return (
    <div className="fixed inset-0 z-50 bg-background overflow-hidden flex justify-center items-center">
      <div className="flex flex-col items-center gap-4">
        <VaartaAnimatedLogo />
        <p className="font-semibold text-lg">Setting up {appName}...</p>
      </div>
    </div>
  );
};

export default UIHydrationComponent;
