// mm:ss, widening to hh:mm:ss
const convertSecondsToMinutes = (duration: number) => {
  const totalSeconds = Math.max(0, Math.round(duration || 0));

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = minutes.toString().padStart(2, '0');
  const ss = seconds.toString().padStart(2, '0');

  if (hours === 0) return `${mm}:${ss}`;

  return `${hours.toString().padStart(2, '0')}:${mm}:${ss}`;
};

export default convertSecondsToMinutes;
