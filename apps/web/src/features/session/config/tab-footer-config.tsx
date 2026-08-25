import { type ReactNode } from 'react';
import {
  Copy,
  Download,
  Layers,
  Play,
  Printer,
  RotateCcwIcon,
  Square,
  Trash2,
} from 'lucide-react';

// --- Types ---

export type FooterButton = {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'default' | 'outline' | 'destructive';
  disabled?: boolean;
  className?: string;
  isCopyAction?: boolean;
  disabledTooltip?: string;
  /** Hover tooltip shown while the button is enabled */
  tooltip?: string;
  buttonStyle?: 'action' | 'link';
};

export type SaveStatusState = 'idle' | 'typing' | 'synced' | 'error' | 'generating';

export type TabFooterConfig = {
  saveStatus?: SaveStatusState;
  buttons: FooterButton[];
  overlay?: ReactNode;
};

// --- Config builders ---

export function getContextFooterConfig({
  onLinkPastSessions,
  saveStatus,
  overlay,
}: {
  onLinkPastSessions: () => void;
  saveStatus: SaveStatusState;
  overlay?: ReactNode;
}): TabFooterConfig {
  return {
    saveStatus,
    buttons: [
      {
        key: 'link',
        label: 'Link past sessions',
        icon: <Layers className="w-4 h-4 text-primary" />,
        onClick: onLinkPastSessions,
        buttonStyle: 'link',
      },
    ],
    overlay,
  };
}

const DOC_BUTTON_CLASS = 'text-primary bg-white border border-[#D1D1D1] hover:bg-[#F5F5F5]';

export function getDocumentFooterConfig({
  onCopy,
  onPrint,
  onDownload,
  saveStatus,
  copyDisabled,
  printDisabled,
  downloadDisabled,
}: {
  onCopy: () => void;
  onPrint: () => void;
  // Omitted on hosts without native HTML->PDF, so the button is left out rather than dead.
  onDownload?: () => void;
  saveStatus: SaveStatusState;
  copyDisabled?: boolean;
  printDisabled?: boolean;
  downloadDisabled?: boolean;
}): TabFooterConfig {
  return {
    saveStatus,
    buttons: [
      {
        key: 'copy',
        label: 'Copy all',
        icon: <Copy className="w-4 h-4" />,
        onClick: onCopy,
        isCopyAction: true,
        disabled: copyDisabled,
        className: DOC_BUTTON_CLASS,
      },
      {
        key: 'print',
        label: 'Print',
        icon: <Printer className="w-4 h-4" />,
        onClick: onPrint,
        disabled: printDisabled,
        className: DOC_BUTTON_CLASS,
      },
      ...(onDownload
        ? [
            {
              key: 'download',
              label: 'Download',
              icon: <Download className="w-4 h-4" />,
              onClick: onDownload,
              disabled: downloadDisabled,
              tooltip: 'Save these notes as a PDF',
              className: DOC_BUTTON_CLASS,
            } satisfies FooterButton,
          ]
        : []),
    ],
  };
}

export function getTranscriptFooterConfig({
  onCopy,
  copyDisabled,
}: {
  onCopy: () => void;
  copyDisabled?: boolean;
}): TabFooterConfig {
  return {
    buttons: [
      {
        key: 'copy',
        label: 'Copy all',
        icon: <Copy className="w-4 h-4" />,
        onClick: onCopy,
        isCopyAction: true,
        disabled: copyDisabled,
        className: 'text-primary bg-white border border-[#D1D1D1] hover:bg-[#F5F5F5]',
      },
    ],
  };
}

export function getErrorFooterConfig({
  onTryAgain,
  onDiscard,
}: {
  onTryAgain: () => void;
  onDiscard: () => void;
}): TabFooterConfig {
  return {
    buttons: [
      {
        key: 'try_again',
        label: 'Try Again',
        icon: <RotateCcwIcon className="w-4 h-4" />,
        onClick: onTryAgain,
        variant: 'default',
      },
      {
        key: 'discard_session',
        label: 'Discard Session',
        icon: <Trash2 className="w-4 h-4" />,
        onClick: onDiscard,
        variant: 'outline',
        className: 'text-destructive border-destructive hover:bg-destructive/10',
      },
    ],
  };
}

export function getChunkLimitFooterConfig({
  onEndRecording,
  onContinueRecording,
  onDiscard,
}: {
  onEndRecording: () => void;
  onContinueRecording: () => void;
  onDiscard: () => void;
}): TabFooterConfig {
  return {
    buttons: [
      {
        key: 'end_recording',
        label: 'End Recording',
        icon: <Square className="w-4 h-4" />,
        onClick: onEndRecording,
        variant: 'default',
      },
      {
        key: 'continue_recording',
        label: 'Continue Recording',
        icon: <Play className="w-4 h-4" />,
        onClick: onContinueRecording,
        variant: 'outline',
      },
      {
        key: 'discard_session',
        label: 'Discard Session',
        icon: <Trash2 className="w-4 h-4" />,
        onClick: onDiscard,
        variant: 'outline',
        className: 'text-destructive border-destructive hover:bg-destructive/10',
      },
    ],
  };
}
