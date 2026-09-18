'use client';

import type { PatientDetails } from '@eka-care/ekascribe-ts-sdk';

import { SESSION_PHASE } from '@/constants/enums';
import { getStorage } from '@/platform';
import useVoice2RxStore from '@/store/store';
import { getPartnerContext } from './utils/partner-context';
import {
  PARTNER_SOURCE,
  SCRIBE_SOURCE,
  type PartnerAckError,
  type PartnerCommandHandlers,
  type PartnerInboundMessage,
  type PartnerOutboundMessage,
  type PartnerPublishedDocument,
} from './types';

type Peer = { window: Window; origin: string };

// The partner pings every 3s while its page is alive. No ping in this long and
// the opener has navigated away or reloaded, so its listener no longer exists:
// posting into it would succeed silently and the doctor would be told the notes
// were sent when nothing received them.
const PEER_LIVENESS_MS = 10_000;

// Bounded so a long-lived tab that starts many sessions can't grow this forever.
const MAX_REMEMBERED_ACKS = 20;

// A partner asking for a session while one of these is live gets rejected, never queued.
const ACTIVE_PHASES = new Set<string>([
  SESSION_PHASE.RECORDING,
  SESSION_PHASE.PAUSED,
  SESSION_PHASE.PROCESSING,
]);

// Module-level so the channel outlives every component, and nothing closes over render state.
let peer: Peer | null = null;
let handlers: PartnerCommandHandlers | null = null;
// One at a time, else two messages in a tick both clear the phase guard.
let commandChain: Promise<void> = Promise.resolve();
let lastPeerContactAt = 0;
// Replayed verbatim when a partner retries a request it never saw the ack for.
const acksByRequestId = new Map<string, PartnerOutboundMessage>();

function post(message: PartnerOutboundMessage): boolean {
  // A sandboxed or file:// opener reports origin "null", which postMessage rejects.
  if (!peer || peer.origin === 'null') return false;
  if (message.type !== 'status') {
    console.log('[partner-session] 4. SENT TO PARTNER', { to: peer.origin, message });
  }
  try {
    peer.window.postMessage(message, peer.origin);
    return true;
  } catch (error) {
    console.error('[partner-session] postMessage failed:', error);
    return false;
  }
}

// ProtectedRouteGuard writes this once whoami resolves; logout clears it. Read fresh, never cached.
function isAuthenticated(): boolean {
  return Boolean(getStorage().session.get('ekascribe-user-uuid'));
}

function ackError(
  requestId: string,
  code: PartnerAckError,
  message: string,
  sessionId: string | null = null
): PartnerOutboundMessage {
  return {
    source: SCRIBE_SOURCE,
    type: 'ack',
    request_id: requestId,
    status: 'error',
    session_id: sessionId,
    error: { code, message },
  };
}

function sendAck(requestId: string, ack: PartnerOutboundMessage) {
  if (acksByRequestId.size >= MAX_REMEMBERED_ACKS) {
    const oldest = acksByRequestId.keys().next().value;
    if (oldest !== undefined) acksByRequestId.delete(oldest);
  }
  acksByRequestId.set(requestId, ack);
  post(ack);
}

// Session-bound events go only to the origin that started that session — with no
// allowlist configured, any site can open Scribe, and without this it could also
// receive another partner's status and published notes.
function ownerOf(sessionId: string): { handoff_id: string; origin: string } | null {
  const content = useVoice2RxStore.getState().sessionV2ContentById[sessionId];
  const context = getPartnerContext(content);
  if (!context) return null;
  if (!peer || peer.origin !== context.origin) return null;
  return { handoff_id: context.handoff_id, origin: context.origin };
}

// The backend drops `patient_details`: CreateSessionRequest (server-side) declares
// no such field, so oid/name/age/gender/mobile are discarded and the stored session
// has no patient column at all. additional_data is the one channel proven to
// round-trip, so a copy goes there too — the top-level field is still sent so this
// starts working by itself the day the backend implements it.
//
// `mobile` is typed number in the SDK and validated with zod before the request
// leaves the browser, so a partner sending "9999999999" as a string fails the whole
// create with a generic error. Coerce a numeric string rather than lose the session.
function normalisePatientDetails(details?: PatientDetails): PatientDetails | undefined {
  if (!details) return undefined;
  const { mobile, ...rest } = details;
  if (typeof mobile === 'string' && /^\d+$/.test(mobile)) {
    return { ...rest, mobile: Number(mobile) };
  }
  return details;
}

async function handleCreateSession(
  message: Extract<PartnerInboundMessage, { type: 'create-session' }>
) {
  const { request_id: requestId, handoff_id: handoffId, payload } = message;

  console.log('[partner-session] 1. RECEIVED FROM PARTNER', {
    origin: peer?.origin,
    handoff_id: handoffId,
    request_id: requestId,
    payload,
  });

  const previousAck = acksByRequestId.get(requestId);
  if (previousAck) {
    post(previousAck);
    return;
  }

  const store = useVoice2RxStore.getState();
  const currentId = store.sessionV2Ongoing.recording_session_id;
  const current = currentId ? store.sessionV2ContentById[currentId] : undefined;

  // A reload wipes the ack map, so the session's own context is what keeps this idempotent.
  if (currentId && getPartnerContext(current)?.handoff_id === handoffId) {
    sendAck(requestId, {
      source: SCRIBE_SOURCE,
      type: 'ack',
      request_id: requestId,
      status: 'created',
      session_id: currentId,
    });
    return;
  }

  if (current && ACTIVE_PHASES.has(current.phase)) {
    sendAck(
      requestId,
      ackError(
        requestId,
        'session_in_progress',
        'A session is already running in Scribe.',
        currentId
      )
    );
    return;
  }

  // Unpublished notes still block; once published the next patient may start.
  if (current?.phase === SESSION_PHASE.OUTPUT && !getPartnerContext(current)?.published_at) {
    sendAck(
      requestId,
      ackError(
        requestId,
        'session_awaiting_publish',
        'The previous session has notes waiting to be published.',
        currentId
      )
    );
    return;
  }

  if (!handlers) {
    sendAck(requestId, ackError(requestId, 'scribe_not_ready', 'Scribe is still starting up.'));
    return;
  }

  // Everything in additional_data goes to the backend as-is. `title` is ALSO
  // read out of it and applied as the session's own title, so it both persists
  // as partner data and shows in the UI — it is copied, not moved.
  const patientDetails = normalisePatientDetails(payload.patient_details);

  const partnerAdditionalData: Record<string, unknown> = {
    ...(payload.additional_data ?? {}),
    // Copied, not moved — see normalisePatientDetails above.
    ...(patientDetails ? { patient_details: patientDetails } : {}),
  };
  const title = payload.additional_data?.title;

  const createArgs = {
    session_id: payload.session_id,
    templates: payload.templates,
    language_hint: payload.language_hint,
    patient_details: patientDetails,
    title: typeof title === 'string' ? title : undefined,
    partner_additional_data: partnerAdditionalData,
    partner_context: {
      handoff_id: handoffId,
      origin: peer?.origin ?? '',
    },
  };
  console.log('[partner-session] 2. HANDED TO SESSION LAYER', createArgs);

  const sessionId = await handlers.createSession(createArgs);

  if (!sessionId) {
    sendAck(
      requestId,
      ackError(requestId, 'create_session_failed', 'Scribe could not create the session.')
    );
    return;
  }

  handlers.goToNewSession();
  sendAck(requestId, {
    source: SCRIBE_SOURCE,
    type: 'ack',
    request_id: requestId,
    status: 'created',
    session_id: sessionId,
  });
}

function enqueue(run: () => Promise<void>) {
  commandChain = commandChain
    .then(run)
    .catch((error) => console.error('[partner-session] command failed:', error));
}

function isPartnerMessage(data: unknown): data is PartnerInboundMessage {
  if (!data || typeof data !== 'object') return false;
  return (data as { source?: string }).source === PARTNER_SOURCE;
}

function handleMessage(event: MessageEvent) {
  if (!isPartnerMessage(event.data) || !event.source) return;

  // event.source survives auth round-trips that sever window.opener.
  peer = { window: event.source as Window, origin: event.origin };
  lastPeerContactAt = Date.now();

  switch (event.data.type) {
    case 'hello': {
      // Answered only once signed in; until then the partner keeps knocking and holds the payload.
      if (isAuthenticated()) {
        post({ source: SCRIBE_SOURCE, type: 'ready', handoff_id: event.data.handoff_id });
      }
      return;
    }
    case 'create-session': {
      const message = event.data;
      if (!message.request_id || !message.handoff_id) {
        post(ackError(message.request_id ?? '', 'invalid_request', 'Missing request_id or handoff_id.'));
        return;
      }
      enqueue(() => handleCreateSession(message));
      return;
    }
  }
}

export function setPartnerCommandHandlers(next: PartnerCommandHandlers | null) {
  handlers = next;
}

export function startPartnerChannel(): () => void {
  window.removeEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);
  return () => window.removeEventListener('message', handleMessage);
}

export function isPartnerConnected(): boolean {
  if (!peer || peer.origin === 'null') return false;
  try {
    if (peer.window.closed) return false;
  } catch {
    return false;
  }
  return Date.now() - lastPeerContactAt < PEER_LIVENESS_MS;
}

export function notifyPartnerStatus(sessionId: string, phase: `${SESSION_PHASE}`) {
  const owner = ownerOf(sessionId);
  if (!owner) return;
  post({
    source: SCRIBE_SOURCE,
    type: 'status',
    handoff_id: owner.handoff_id,
    session_id: sessionId,
    phase,
  });
}

export function publishToPartner(
  sessionId: string,
  documents: PartnerPublishedDocument[]
): boolean {
  const owner = ownerOf(sessionId);
  if (!owner) return false;
  return post({
    source: SCRIBE_SOURCE,
    type: 'published',
    handoff_id: owner.handoff_id,
    session_id: sessionId,
    documents,
  });
}
