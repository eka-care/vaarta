import { useState, useEffect } from 'react';
import { Download, Loader2, Timer } from 'lucide-react';
import {
  CustomTooltip,
  CustomTooltipContent,
  CustomTooltipTrigger,
} from '@/shared-components/custom-tooltip';
import { getBlobStore } from '@/platform';
import useVoice2RxStore from '@/store/store';
import convertSecondsToMinutes from '@/utils/convert-seconds-to-minutes';

interface DownloadAudioButtonProps {
  sessionID: string;
}

const DownloadAudioButton = ({ sessionID }: DownloadAudioButtonProps) => {
  const [isDownloadAudioButtonLoading, setIsDownloadAudioButtonLoading] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [blobDuration, setBlobDuration] = useState(0);
  const storeDuration = useVoice2RxStore(
    (s) => s.sessionV2ContentById[sessionID]?.session_duration || 0
  );
  const additionalDataDuration = useVoice2RxStore((s) => {
    const value = s.sessionV2ContentById[sessionID]?.additional_data?.audio_duration;
    return typeof value === 'number' ? value : Number(value) || 0;
  });
  const sessionDuration = storeDuration || blobDuration || additionalDataDuration;

  useEffect(() => {
    let isMounted = true;
    const checkAudioAvailability = async () => {
      try {
        const exists = await getBlobStore().has(sessionID);
        if (!isMounted) return;
        setHasAudio(exists);

        if (exists && !storeDuration) {
          const blob = await getBlobStore().get(sessionID, '');
          if (!blob || !isMounted) return;
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.addEventListener('loadedmetadata', () => {
            if (isMounted && isFinite(audio.duration)) {
              setBlobDuration(Math.round(audio.duration));
            }
            URL.revokeObjectURL(url);
          });
          audio.addEventListener('error', () => URL.revokeObjectURL(url));
        }
      } catch (error) {
        console.error('Failed to check audio availability', error);
        if (isMounted) {
          setHasAudio(false);
        }
      }
    };

    if (sessionID) {
      checkAudioAvailability();
    }

    return () => {
      isMounted = false;
    };
  }, [sessionID, storeDuration]);

  const handleDownloadAudio = async () => {
    setIsDownloadAudioButtonLoading(true);

    try {
      const combinedBlob = await getBlobStore().get(sessionID, '');

      if (!combinedBlob) {
        console.warn('No audio chunks found');
        return;
      }

      const url = URL.createObjectURL(combinedBlob);

      const link = document.createElement('a');
      link.href = url;
      link.download = `session-${sessionID}.mp3`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('failed to get audio', error);
    } finally {
      setIsDownloadAudioButtonLoading(false);
    }
  };

  if (!hasAudio) {
    if (sessionDuration <= 0) return null;

    // Duration only — the recording is no longer available to download.
    return (
      <span className="flex items-center gap-1 py-1 text-sm font-medium text-secondary-foreground">
        <Timer className="size-4" />
        {convertSecondsToMinutes(sessionDuration)}
      </span>
    );
  }

  return (
    <CustomTooltip>
      <CustomTooltipTrigger asChild>
        <button
          className="flex items-center gap-1 px-2 py-1 bg-white border border-[#D1D1D1] rounded-lg cursor-pointer hover:bg-[#F5F5F5] transition-colors"
          onClick={handleDownloadAudio}
          disabled={isDownloadAudioButtonLoading}
        >
          {sessionDuration > 0 && (
            <span className="text-sm font-medium text-foreground">
              {convertSecondsToMinutes(sessionDuration)}
            </span>
          )}
          {isDownloadAudioButtonLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4 text-primary" />
          )}
        </button>
      </CustomTooltipTrigger>
      <CustomTooltipContent collisionPadding={8}>Download recording</CustomTooltipContent>
    </CustomTooltip>
  );
};

export default DownloadAudioButton;
