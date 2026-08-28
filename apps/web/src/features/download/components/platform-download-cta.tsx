'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Button } from '@ui/src';
import { MAC_APP_DOWNLOAD_URL, WINDOWS_APP_DOWNLOAD_URL } from '@/constants/constant';
import { useDesktopOS } from '../hooks/use-desktop-os';
import { WindowsIcon } from './windows-icon';

// Leads with the installer for the visitor's OS and offers the other one as the
// sub-link, so a Windows visitor never has to hunt for their build.
export function PlatformDownloadCta() {
  const os = useDesktopOS();
  const isWindows = os === 'windows';

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex flex-col items-center gap-2">
        <Button asChild className="h-10 min-w-20 gap-1 rounded-lg px-3">
          <a href={isWindows ? WINDOWS_APP_DOWNLOAD_URL : MAC_APP_DOWNLOAD_URL} download>
            <span className="px-1 text-sm font-medium leading-6">
              {isWindows ? 'Download for Windows' : 'Download for MacOS'}
            </span>
            {isWindows ? (
              <WindowsIcon className="size-4" />
            ) : (
              // 16px icon box; the Apple mark itself is 12 x 14.05 inside it, per Figma.
              <span className="relative block size-4">
                <img
                  src="/assets/download/apple.svg"
                  alt=""
                  className="absolute left-[12.5%] top-[4.17%] h-[87.8%] w-[75%]"
                />
              </span>
            )}
          </a>
        </Button>
        <a
          href={isWindows ? MAC_APP_DOWNLOAD_URL : WINDOWS_APP_DOWNLOAD_URL}
          download
          className="text-center text-xs leading-4 text-muted-foreground hover:underline"
        >
          {isWindows ? 'Download for MacOS instead' : 'Download for Windows instead'}
        </a>
      </div>

      <Button
        asChild
        variant="outline"
        className="h-10 w-[194px] gap-1 rounded-lg px-3 text-primary hover:text-primary"
      >
        <Link href="/">
          <span className="px-1 text-sm font-medium leading-6">Try on web</span>
          <ChevronRight className="size-4" strokeWidth={1.5} />
        </Link>
      </Button>
    </div>
  );
}
