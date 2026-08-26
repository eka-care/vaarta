import { Layers, NotebookPen, PenLine } from 'lucide-react';
import Image from 'next/image';
import TutorialVideoCard from './tutorial-video-card';

function TranscriptIdleState() {
  return (
    <div className="flex-1 h-full flex flex-col items-center justify-center gap-8 relative px-4">
      <TutorialVideoCard />

      <div className="flex flex-col items-center gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <h3 className="text-2xl font-semibold leading-8 text-[#1A1A1A] max-w-[330px]">
            Ready to transcribe
          </h3>
          <p className="text-sm text-[#595959] max-w-[300px]">
            Hit Start transcribing when you're ready. The transcript will appear here
            automatically.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 opacity-50 w-full max-w-[504px]">
        <div className="flex-1 h-px bg-[#D1D1D1]" />
        <span className="text-xs font-medium text-[#767676] whitespace-nowrap">while you wait</span>
        <div className="flex-1 h-px bg-[#D1D1D1]" />
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex flex-col gap-2 sm:gap-4 p-2 sm:p-3 w-full sm:w-40 bg-[#F5F5F5] border border-[#D1D1D1] rounded-lg">
          <div className="flex flex-row space-x-2 items-center">
            <div className="w-8 h-8 rounded-lg bg-white border border-[#D1D1D1] flex items-center justify-center">
              <Layers className="w-4 h-4 text-[var(--foreground)]" />
            </div>
            <span className="text-sm font-medium text-[#1A1A1A] sm:hidden">Add context</span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[#1A1A1A] hidden sm:flex">Add context</span>
            <span className="text-xs text-[#767676]">
              Add any background details or instructions before you record.
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:gap-4 p-2 sm:p-3 w-full sm:w-40 bg-[#F5F5F5] border border-[#D1D1D1] rounded-lg">
          <div className="flex flex-row space-x-2 items-center">
            <div className="w-8 h-8 rounded-lg bg-white border border-[#D1D1D1] flex items-center justify-center">
              <NotebookPen className="w-4 h-4 text-(--foreground)" />
            </div>
            <span className="text-sm font-medium text-[#1A1A1A] sm:hidden">Take notes</span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[#1A1A1A] hidden sm:flex">Take notes</span>
            <span className="text-xs text-[#767676]">
              Use + to open a blank note and type anything while you record.
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:gap-4 p-2 sm:p-3 w-full sm:w-40 bg-[#F5F5F5] border border-[#D1D1D1] rounded-lg">
          <div className="flex flex-row space-x-2 items-center">
            <div className="w-8 h-8 rounded-lg bg-white border border-[#D1D1D1] flex items-center justify-center">
              <PenLine className="w-4 h-4 text-(--foreground)" />
            </div>
            <span className="text-sm font-medium text-[#1A1A1A] sm:hidden">Generate notes</span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[#1A1A1A] hidden sm:flex">
              Generate notes
            </span>
            <span className="text-xs text-[#767676]">
              After recording, use + to convert notes to any template.
            </span>
          </div>
        </div>
      </div>

      <div className="hidden sm:block absolute top-16 right-12" style={{ opacity: 0.8 }}>
        <Image src="/assets/curved-arrow.svg" alt="" width={44} height={104} />
      </div>
    </div>
  );
}

export default TranscriptIdleState;
