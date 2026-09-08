'use client';

import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ui/src';
import {
  MAC_ARM_APP_DOWNLOAD_URL,
  MAC_UNIVERSAL_APP_DOWNLOAD_URL,
  WINDOWS_APP_DOWNLOAD_URL,
} from '@/constants/constant';
import { useDesktopOS, type DesktopOS } from '../hooks/use-desktop-os';
import { AppleIcon } from './apple-icon';
import { WindowsIcon } from './windows-icon';

const MAC_ARM = {
  label: 'Download for Mac (Apple Silicon)',
  href: MAC_ARM_APP_DOWNLOAD_URL,
  Icon: AppleIcon,
};
const MAC_INTEL = {
  label: 'Download for Mac (Intel)',
  href: MAC_UNIVERSAL_APP_DOWNLOAD_URL,
  Icon: AppleIcon,
};
const WINDOWS = {
  label: 'Download for Windows',
  href: WINDOWS_APP_DOWNLOAD_URL,
  Icon: WindowsIcon,
};

// A Mac visitor can't be probed for Intel vs Apple Silicon, so lead with Apple
// Silicon and park every other build under "Other platforms".
const BUILDS: Record<DesktopOS, { primary: typeof MAC_ARM; others: (typeof MAC_ARM)[] }> = {
  mac: { primary: MAC_ARM, others: [MAC_INTEL, WINDOWS] },
  windows: { primary: WINDOWS, others: [MAC_ARM, MAC_INTEL] },
};

export function PlatformDownloadCta() {
  const { primary, others } = BUILDS[useDesktopOS()];

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div className="flex flex-col items-center gap-2">
        <Button asChild className="h-10 min-w-20 gap-1 rounded-lg px-3">
          <a href={primary.href} download>
            <span className="px-1 text-sm font-medium leading-6">{primary.label}</span>
            <primary.Icon className="size-4" />
          </a>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-auto min-w-16 gap-0 rounded-lg px-1.5 py-0.5 text-secondary-foreground has-[>svg]:px-1.5"
            >
              <span className="px-1 text-sm font-medium leading-6">Other platforms</span>
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            collisionPadding={8}
            align="center"
            className="min-w-55 border-border shadow"
          >
            {others.map(({ label, href, Icon }) => (
              <DropdownMenuItem key={label} asChild className="justify-between">
                <a href={href} download>
                  <span className="leading-5">{label}</span>
                  <Icon className="size-4 text-popover-foreground" />
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Button
        asChild
        variant="outline"
        className="h-10 w-49 gap-1 rounded-lg px-3 text-primary hover:text-primary"
      >
        <Link href="/">
          <span className="px-1 text-sm font-medium leading-6">Try on web</span>
          <ChevronRight className="size-4" strokeWidth={1.5} />
        </Link>
      </Button>
    </div>
  );
}
