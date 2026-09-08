import { PlatformDownloadCta } from './platform-download-cta';

export function DownloadHero() {
  return (
    <section className="relative mx-auto flex w-full max-w-[1440px] flex-col items-center justify-center gap-12 px-4 pb-16 pt-12 md:px-8 md:pb-22 md:pt-22 xl:px-16">
      <div className="flex flex-col items-center justify-center gap-4">
        <div className="flex items-center justify-center rounded-full border border-[#a2bafa] bg-background px-4 py-1">
          <p className="text-center text-sm font-medium leading-5 text-card-foreground">
            Available in 15+ regional Indian languages
          </p>
        </div>

        <h1 className="text-center text-[40px] font-light leading-[1.1] tracking-tight text-card-foreground sm:text-[56px] xl:text-[72px]">
          The ambient <span className="font-medium text-primary">AI Scribe</span>
          <br />
          for any conversation
        </h1>

        <p className="max-w-[525px] text-center text-lg leading-7 text-card-foreground">
          Vaarta listens to any conversation — meetings, interviews, calls — and turns it into
          clear, structured notes.
        </p>
      </div>

      <PlatformDownloadCta />
    </section>
  );
}
