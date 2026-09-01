import { SESSION_PHASE } from '@/constants/enums';
import useVoice2RxStore from '@/store/store';
import { handleUserLogout } from './user-auth-logout-utility-methods';

const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please log in again.';
// Logout clears the store, so hold the message on screen before it is wiped.
const LOGOUT_DELAY_MS = 2500;

let logoutScheduled = false;

function isRecordingInProgress(): boolean {
  const { sessionV2Ongoing, sessionV2ContentById } = useVoice2RxStore.getState();
  const sessionId = sessionV2Ongoing.recording_session_id;
  if (!sessionId) return false;

  const phase = sessionV2ContentById[sessionId]?.phase;
  return phase === SESSION_PHASE.RECORDING || phase === SESSION_PHASE.PAUSED;
}

// Single owner of the logout decision — call sites only see success or failure.
export function notifyAuthDead(): void {
  // Chunks upload to presigned URLs with no auth, so a live recording survives a dead token.
  if (isRecordingInProgress()) return;
  // A dead token fails every in-flight call at once; only the first one logs out.
  if (logoutScheduled) return;
  logoutScheduled = true;

  useVoice2RxStore.getState().setWarningInfo({
    message: SESSION_EXPIRED_MESSAGE,
    type: 'error',
    screen: 'recording',
  });

  setTimeout(() => {
    void handleUserLogout().finally(() => {
      logoutScheduled = false;
    });
  }, LOGOUT_DELAY_MS);
}
