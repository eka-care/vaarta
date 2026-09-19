import type { Metadata } from 'next';
import { DownloadNav } from '@/features/download/components/download-nav';
import { DownloadHero } from '@/features/download/components/download-hero';
import { DemoVideo } from '@/features/download/components/demo-video';
import { FeatureCards } from '@/features/download/components/feature-cards';
import { DownloadFooter } from '@/features/download/components/download-footer';

export const metadata: Metadata = {
  title: 'Download — The ambient AI Scribe',
  description:
    'Listens to any conversation — meetings, interviews, calls — and turns it into clear, structured notes. Download for MacOS or Windows.',
};

const DownloadPage = () => {
  // No overflow-x-hidden on the root — with overflow-y visible it computes to auto and nests a second scroller inside the app shell.
  return (
    <div className="relative flex min-h-full w-full flex-col bg-[#fcfcfc]">
      {/* Hero band: #f5f5f5 fading into the page background over the first 900px */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-225 bg-linear-to-b from-[#f5f5f5] to-[#fcfcfc]" />
      {/* Clipped so the wide gradient can bleed without adding a horizontal scrollbar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-363 overflow-hidden">
        {/* Height is pinned, not derived from width — top-83.25 + h-279.75 must equal the h-363 clip or it cuts a hard edge through the live ellipse */}
        <img
          src="/assets/download/gradient-hero.svg"
          alt=""
          aria-hidden="true"
          className="absolute left-[-17.4%] top-83.25 h-279.75 w-[134.7%] max-w-none select-none"
        />
      </div>
      {/* Lower glow: Figma starts it 455px above the page bottom and clips the rest */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-113.75 overflow-hidden">
        <img
          src="/assets/download/gradient-bottom.svg"
          alt=""
          aria-hidden="true"
          className="absolute left-[-31.9%] top-0 h-268 w-[163.7%] max-w-none select-none"
        />
      </div>

      <div className="relative flex flex-1 flex-col">
        <DownloadNav />
        <DownloadHero />
        <DemoVideo />
        <FeatureCards />
        {/* mt-auto keeps the footer on the bottom edge when the content is shorter than the viewport */}
        <div className="mt-auto">
          <DownloadFooter />
        </div>
      </div>
    </div>
  );
};

export default DownloadPage;
