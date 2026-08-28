'use client';

import { Button } from '@ui/src';
import { ShieldCheck } from 'lucide-react';
import { MAC_APP_DOWNLOAD_URL, WINDOWS_APP_DOWNLOAD_URL } from '@/constants/constant';

function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
      <path d="M3 12V6.75l6-1.32v6.48L3 12zm17-9v8.75l-10 .08V5.21L20 3zM3 13l6 .09v6.81l-6-1.15V13zm17 .25V22l-10-1.91V13.1l10 .15z" />
    </svg>
  );
}

const isMac = typeof window !== 'undefined' && /Macintosh/.test(window.navigator.userAgent);

const DownloadDesktopApp = () => {
  const platformLabel = isMac ? 'macOS' : 'Windows';
  const note = isMac ? 'Optimized for macOS 12 and above' : 'Optimized for Windows 10 and above';

  return (
    <div className="col-span-2 flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-5 max-w-xs text-center p-6">
        <div className="w-14 h-14 mx-auto bg-[linear-gradient(135deg,#f0f4ff,#e8edff)] rounded-[14px] flex items-center justify-center border border-[rgba(33,95,255,0.1)] p-2">
          <img src="/assets/vaarta-icon.svg" alt="Vaarta" className="w-full h-full" />
        </div>

        <div className="flex flex-col gap-1">
          <p className="font-semibold text-base leading-6">Download Vaarta for Desktop</p>
          <p className="text-sm text-muted-foreground leading-5">
            Runs natively on desktop, requires no browser, and syncs instantly across devices.
          </p>
        </div>

        <div className="flex flex-col justify-items-center gap-1 w-full">
          <Button
            asChild
            className="w-full inline-flex items-center gap-2 py-4 px-7 text-white border-none rounded-[10px] text-[0.9rem] font-semibold no-underline transition-all duration-200 relative overflow-hidden shadow-[0_2px_8px_rgba(33,95,255,0.25)]"
          >
            <a href={isMac ? MAC_APP_DOWNLOAD_URL : WINDOWS_APP_DOWNLOAD_URL} download>
              {isMac ? <AppleIcon /> : <WindowsIcon />}
              Download for {platformLabel}
            </a>
          </Button>

          <div className="flex justify-center items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>{note}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DownloadDesktopApp;
