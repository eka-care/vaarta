import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { VaartaLogoLottie } from '@/shared-components/vaarta-logo-lottie';
import { TUTORIAL_VIDEO_SRC } from '@/constants/tutorial';

export const metadata: Metadata = {
  title: 'Vaarta tutorial — a short tour',
  description: 'A short tour of Vaarta, the ambient AI scribe for note taking.',
};

const TutorialPage = () => {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#fcfcfc]">
      <div className="mx-auto flex h-full w-full min-h-0 max-w-360 flex-col gap-4 px-4 py-6 md:px-8">
        <div className="flex shrink-0 items-center gap-3">
          <Link
            href="/"
            aria-label="Back to home"
            className="flex size-8 items-center justify-center rounded-lg text-[#1A1A1A] transition-colors hover:bg-black/5"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <VaartaLogoLottie />
        </div>
        <h1 className="shrink-0 text-2xl font-semibold leading-8 text-[#1A1A1A]">
          New to Vaarta? Watch a short tour.
        </h1>
        {/* min-h-0 is load-bearing: flex min-height:auto would otherwise floor this at the video's intrinsic height */}
        <div className="min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-border bg-black">
          <video className="size-full object-contain" controls autoPlay playsInline>
            <source src={TUTORIAL_VIDEO_SRC} type="video/mp4" />
          </video>
        </div>
      </div>
    </div>
  );
};

export default TutorialPage;
