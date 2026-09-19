'use client';

import { Check, Plus, Search, X } from 'lucide-react';
import './feature-cards.css';
import { useAppName } from '@/config/app-branding';

// Cards keep their designed 310x295 footprint at every breakpoint — their inner
// artwork is positioned against that box — and the grid reflows around them.
// fc-card/group are the hover hooks the artwork animations key off. Both shadows
// are single-layer on purpose: box-shadow only interpolates smoothly between
// lists of the same length, and Tailwind's default rest state is a 5-layer
// transparent stack that would make the hover snap instead of ease.
const CARD_CLASS =
  'fc-card group relative h-[295px] w-[310px] shrink-0 overflow-hidden rounded-2xl border border-border bg-white shadow-xs transition-[transform,box-shadow] duration-300 ease-out hover:shadow-[0_8px_20px_-8px_rgba(16,24,40,0.13)] motion-safe:hover:-translate-y-1';

// Figma paints a wide, shallow radial glow rising from the bottom edge.
const CARD_GLOW: React.CSSProperties = {
  backgroundImage:
    'radial-gradient(274px 114px at 50% 100%, rgba(209,222,255,1) 0%, rgba(209,222,255,0) 100%)',
};

function CardHeading({ title, body }: { title: string; body: string }) {
  return (
    <div className="absolute left-[23px] top-[23px] flex w-[262px] flex-col gap-2 text-card-foreground">
      <p className="text-2xl font-medium leading-[1.1] tracking-[-0.6px]">{title}</p>
      <p className="text-sm leading-5">{body}</p>
    </div>
  );
}

// The inner white panel shared by the Templates and Add-context cards: it starts
// mid-card and bleeds off the bottom edge, so only the top corners are rounded.
function CardPanel({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <div className="absolute left-[23px] top-[152px] flex w-[262px] flex-col gap-3 rounded-t-lg border border-border bg-background p-3">
      <p className="text-[10px] font-semibold uppercase leading-3 tracking-[0.8px] text-muted-foreground">
        {eyebrow}
      </p>
      <div className="flex w-full flex-col gap-2">{children}</div>
    </div>
  );
}

function LanguageChip({ label, width }: { label: string; width?: number }) {
  return (
    <div
      className="flex h-7 shrink-0 items-center justify-center rounded-full border border-border bg-background px-3 py-0.5"
      style={width ? { width } : undefined}
    >
      <p className="whitespace-nowrap text-base leading-7 text-foreground">{label}</p>
    </div>
  );
}

// Chips whose scripts Figma flattened to vectors — kept as exported SVG so the
// Indic text renders identically without shipping extra script fonts.
function LanguageChipImage({ src, width }: { src: string; width: number }) {
  return <img src={src} alt="" className="h-7 shrink-0 max-w-none" style={{ width }} />;
}

// The chips are rendered twice so the row can loop without a seam: translating by
// exactly one copy (plus half the 4px gap) lands on a visually identical frame.
// The track is paused at rest and resumes on hover, so leaving the card freezes
// it mid-flow instead of snapping it home.
function MarqueeRow({
  position,
  direction,
  duration,
  children,
}: {
  position: string;
  direction: 'left' | 'right';
  duration: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`absolute ${position}`}>
      <div
        className={`fc-marquee fc-marquee-${direction} flex w-max items-center gap-1`}
        style={{ animationDuration: duration }}
      >
        <div className="flex shrink-0 items-center gap-1">{children}</div>
        <div className="flex shrink-0 items-center gap-1" aria-hidden="true">
          {children}
        </div>
      </div>
    </div>
  );
}

function MultilingualCard() {
  return (
    <div className={CARD_CLASS} style={CARD_GLOW}>
      <CardHeading
        title="Multilingual"
        body="Capture conversations in English or 15+ Indian languages, even when speakers switch mid-sentence."
      />
      <div className="absolute left-[-1px] top-[186px] h-[100px] w-[310px]">
        {/* Every label is distinct, and each row's last chip differs from its first — the
            marquee butts those two together at the wrap. */}
        <MarqueeRow position="left-[-71px] top-0 h-7" direction="left" duration="20s">
          <LanguageChip label="भोजपुरी" />
          <LanguageChip label="English" />
          <LanguageChipImage src="/assets/download/lang-1.svg" width={57.605} />
          <LanguageChipImage src="/assets/download/lang-2.svg" width={59.338} />
          <LanguageChipImage src="/assets/download/lang-3.svg" width={93.292} />
        </MarqueeRow>
        <MarqueeRow position="left-[-25px] top-[36px]" direction="right" duration="26s">
          <LanguageChipImage src="/assets/download/lang-7.svg" width={76.559} />
          <LanguageChipImage src="/assets/download/lang-8.svg" width={76.559} />
          <LanguageChipImage src="/assets/download/lang-9.svg" width={76.559} />
          <LanguageChipImage src="/assets/download/lang-10.svg" width={76.559} />
          <LanguageChip label="हरियाणवी" width={76.559} />
        </MarqueeRow>
        <MarqueeRow position="left-[-5px] top-[72px] h-7" direction="left" duration="23s">
          <LanguageChip label="कोंकणी" />
          <LanguageChipImage src="/assets/download/lang-4.svg" width={64.251} />
          <LanguageChip label="मराठी" />
          <LanguageChipImage src="/assets/download/lang-5.svg" width={64.023} />
          <LanguageChipImage src="/assets/download/lang-6.svg" width={47} />
        </MarqueeRow>
      </div>
    </div>
  );
}

function TemplatesCard() {
  const appName = useAppName();
  return (
    <div className={CARD_CLASS} style={CARD_GLOW}>
      <CardHeading
        title="Templates"
        body={`Choose from ready-made note formats, or build and save your own. ${appName} fills them in automatically.`}
      />
      <CardPanel eyebrow="Templates">
        <div className="flex w-full items-center gap-1">
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-background p-1">
            <Search
              className="size-3 shrink-0 text-muted-foreground transition-transform duration-500 ease-out motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:rotate-12"
              strokeWidth={1.5}
            />
            <p className="whitespace-nowrap text-[10px] leading-[1.1] text-muted-foreground">
              Search templates
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background py-1 pl-1 pr-2">
            <Plus className="size-3 text-primary" strokeWidth={1.5} />
            <p className="whitespace-nowrap text-[10px] leading-[1.1] text-primary">Create new</p>
          </div>
        </div>

        {/* On hover the selection moves from the first row to the second — the
            highlight and the tick cross-fade together. */}
        <div className="flex w-full flex-col gap-1">
          <div className="flex w-full items-center justify-between rounded-lg bg-accent p-2 transition-colors duration-300 group-hover:bg-transparent">
            <div className="flex w-[92px] flex-col gap-0.5">
              <p className="text-xs font-medium leading-[1.1] text-card-foreground">Meeting notes</p>
              <p className="text-[10px] leading-3 text-muted-foreground">General</p>
            </div>
            <Check
              className="size-4 shrink-0 text-card-foreground transition-opacity duration-300 group-hover:opacity-0"
              strokeWidth={1.5}
            />
          </div>
          <div className="flex w-full items-center justify-between rounded-lg p-2 transition-colors duration-300 group-hover:bg-accent">
            <div className="flex w-[92px] flex-col gap-0.5">
              <p className="text-xs font-medium leading-[1.1] text-card-foreground">Lecture notes</p>
              <p className="text-[10px] leading-3 text-muted-foreground">Research</p>
            </div>
            <Check
              className="size-4 shrink-0 text-card-foreground opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              strokeWidth={1.5}
            />
          </div>
        </div>
      </CardPanel>
    </div>
  );
}

function AddContextCard() {
  const appName = useAppName();
  return (
    <div className={CARD_CLASS} style={CARD_GLOW}>
      <CardHeading
        title="Add context"
        body={`Type extra context, attach documents, or link past notes. ${appName} takes it all into account when writing the note.`}
      />
      <CardPanel eyebrow="Add context">
        {/* On hover the note types itself out, then the attachment lands under it. */}
        <div className="flex h-[38px] w-full items-start overflow-hidden rounded-md border border-border bg-background p-2">
          <p className="fc-typed w-full overflow-hidden whitespace-nowrap text-[10px] leading-[1.1] text-foreground">
            This is a follow-up to last week’s planning ca|
          </p>
        </div>

        <div className="fc-attachment flex w-full items-center justify-between rounded-lg border border-border bg-background p-2">
          <div className="flex items-center gap-2">
            <div className="flex size-[29px] shrink-0 items-center justify-center rounded bg-accent p-2">
              <p className="text-[10px] font-medium leading-[1.1] text-card-foreground">PDF</p>
            </div>
            <div className="flex flex-col gap-0.5 whitespace-nowrap">
              <p className="text-xs font-medium leading-[1.1] text-card-foreground">Q3_planning</p>
              <p className="text-[10px] leading-3 text-muted-foreground">123 KB · Uploaded</p>
            </div>
          </div>
          <X className="size-4 shrink-0 text-card-foreground" strokeWidth={1.5} />
        </div>
      </CardPanel>
    </div>
  );
}

function DataPrivacyCard() {
  return (
    <div className={CARD_CLASS} style={CARD_GLOW}>
      <CardHeading
        title="Data privacy"
        body="Every conversation is encrypted and stored on secure, HIPAA-compliant servers in India."
      />
      <div className="absolute left-[23px] top-[152px] size-[262px] overflow-hidden rounded-lg border border-border">
        <img
          src="/assets/download/privacy-illustration.png"
          alt=""
          className="absolute left-[-4.32%] top-[-18.61%] size-[108.4%] max-w-none"
        />
        {/* Sized and placed to sit exactly on the dashed orbit baked into the PNG,
            so the dot rides that path instead of floating beside it. */}
        <div className="fc-orbit pointer-events-none absolute left-14 top-[17px] size-[150px]">
          <span className="absolute left-1/2 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-4 ring-primary/15" />
        </div>
      </div>
    </div>
  );
}

export function FeatureCards() {
  return (
    <section className="relative mx-auto w-full max-w-[1440px] px-4 pb-24 pt-24 md:px-8 md:pb-[243px] md:pt-[190px] xl:px-16">
      <div className="relative flex flex-col items-center gap-4">
        <div className="flex flex-wrap items-center justify-center gap-4">
          <p className="text-center text-[32px] font-medium leading-[1.1] tracking-tight text-card-foreground sm:text-[40px] xl:text-5xl">
            Everything
          </p>
          <img
            src="/assets/download/vaarta-wordmark.svg"
            alt="vaarta"
            className="h-[25px] w-[112px] sm:h-[31px] sm:w-[140px] xl:h-[37px] xl:w-[168px]"
          />
          <p className="text-center text-[32px] font-medium leading-[1.1] tracking-tight text-card-foreground sm:text-[40px] xl:text-5xl">
            does for you
          </p>
        </div>
        <p className="text-center text-lg leading-7 text-card-foreground">
          From language to security, here&apos;s what powers every note
        </p>
      </div>

      <div className="relative mt-10 grid grid-cols-1 justify-items-center gap-6 md:mt-16 md:grid-cols-2 xl:grid-cols-4">
        <MultilingualCard />
        <TemplatesCard />
        <AddContextCard />
        <DataPrivacyCard />
      </div>
    </section>
  );
}
