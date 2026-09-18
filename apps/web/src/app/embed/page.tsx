'use client';

import { Loader2 } from 'lucide-react';
import { VaartaLogoLottie } from '@/shared-components/vaarta-logo-lottie';

// Partner handoff popup lands here and waits; the bridge in ScreenContainer does the work.
export default function EmbedHandoffPage() {
  return (
    <div className="flex min-h-full w-full flex-1 flex-col items-center justify-center gap-6 bg-background px-4">
      <VaartaLogoLottie />
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Starting your session…</span>
      </div>
      <p className="max-w-xs text-center text-xs text-muted-foreground">
        Keep this window open. You can close it once you have published your notes.
      </p>
    </div>
  );
}
