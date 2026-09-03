'use client';

import { forwardRef, memo } from 'react';
import { Monitor, Video, ShieldCheck, X, ExternalLink } from 'lucide-react';
import { Button } from '@ui/src';

type SidebarDesktopAppPopupProps = {
  onDownloadClick: () => void;
  onClose: () => void;
};

// Floating card beside the sidebar footer promoting the desktop app after login.
const SidebarDesktopAppPopup = memo(
  forwardRef<HTMLDivElement, SidebarDesktopAppPopupProps>(function SidebarDesktopAppPopup(
    { onDownloadClick, onClose },
    ref
  ) {
    return (
      <div
        ref={ref}
        role="dialog"
        aria-label="Get the Vaarta desktop app"
        className="absolute left-40 bottom-12 w-[292px] z-50 bg-white rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.12)] border border-border p-3"
      >
        {/* Icon + close button */}
        <div className="flex items-start justify-between">
          <div className="size-9 rounded-lg bg-[#E9EFFF] flex items-center justify-center">
            <Monitor className="size-4 text-primary" strokeWidth={1.75} />
          </div>
          <button
            type="button"
            aria-label="Close"
            className="p-1 rounded hover:bg-[#F3F4F6] cursor-pointer"
            onClick={onClose}
          >
            <X className="size-4 text-[#6B7280]" />
          </button>
        </div>

        {/* Title */}
        <p className="mt-3 text-[15px] font-semibold leading-snug text-[#1A1A1A]">
          Get the Vaarta desktop app
        </p>

        {/* Feature highlights */}
        <ul className="mt-2.5 flex flex-col gap-2">
          <li className="flex items-start gap-2 text-xs leading-snug text-[#1A1A1A]">
            <Video className="size-4 shrink-0 text-primary" strokeWidth={1.75} />
            <span>
              The desktop app captures system audio, so you can record and transcribe calls on
              Google Meet, Zoom and more.
            </span>
          </li>
          <li className="flex items-start gap-2 text-xs leading-snug text-[#1A1A1A]">
            <ShieldCheck className="size-4 shrink-0 text-[#16A34A]" strokeWidth={1.75} />
            <span>Every conversation is encrypted and stored on secure, HIPAA-compliant servers in India.</span>
          </li>
        </ul>

        {/* Download CTA */}
        <Button
          className="mt-3 w-full h-8 rounded-lg text-xs font-medium cursor-pointer"
          onClick={onDownloadClick}
        >
          See download options
          <ExternalLink className="size-3.5" />
        </Button>

        {/* Platform availability note */}
        <p className="mt-2 text-[10px] text-center text-[#767676]">
          Available for Windows &amp; MacOS (Apple Silicon and Intel)
        </p>
      </div>
    );
  })
);

export default SidebarDesktopAppPopup;
