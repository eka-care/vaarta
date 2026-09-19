import type { PatientDetails } from '@eka-care/ekascribe-ts-sdk';

import { SESSION_PHASE } from '@/constants/enums';

// Every message is tagged with its author; a page may host other postMessage traffic.
export const PARTNER_SOURCE = 'eka-scribe-embed';
export const SCRIBE_SOURCE = 'eka-scribe';

// What the partner may set on the session it is asking Scribe to create.
export type PartnerSessionRequest = {
  session_id?: string;
  templates?: string[];
  /** Language codes for the audio. Use ['auto_detect'] to let Scribe decide. */
  language_hint?: string[];
  patient_details?: PatientDetails;
  /**
   * Stored verbatim and returned on session fetch — where partners keep their own
   * references. `title` additionally becomes the session's editable title.
   */
  additional_data?: {
    title?: string;
    attendees?: string;
  } & Record<string, unknown>;
};

export type PartnerInboundMessage =
  | { source: typeof PARTNER_SOURCE; type: 'hello'; handoff_id: string }
  | {
      source: typeof PARTNER_SOURCE;
      type: 'create-session';
      handoff_id: string;
      request_id: string;
      payload: PartnerSessionRequest;
    };

export type PartnerAckError =
  | 'session_in_progress'
  | 'session_awaiting_publish'
  | 'scribe_not_ready'
  | 'create_session_failed'
  | 'invalid_request';

export type PartnerPublishedDocument = {
  document_id: string;
  document_name: string;
  template_id: string;
  document_type: string;
  type: string;
  status: string;
  errors: unknown[];
  warnings: unknown[];
  presigned_url: string | null;
};

export type PartnerOutboundMessage =
  | { source: typeof SCRIBE_SOURCE; type: 'ready'; handoff_id: string }
  | {
      source: typeof SCRIBE_SOURCE;
      type: 'ack';
      request_id: string;
      status: 'created';
      session_id: string;
    }
  | {
      source: typeof SCRIBE_SOURCE;
      type: 'ack';
      request_id: string;
      status: 'error';
      session_id: string | null;
      error: { code: PartnerAckError; message: string };
    }
  | {
      source: typeof SCRIBE_SOURCE;
      type: 'status';
      handoff_id: string;
      session_id: string;
      phase: `${SESSION_PHASE}`;
    }
  | {
      source: typeof SCRIBE_SOURCE;
      type: 'published';
      handoff_id: string;
      session_id: string;
      documents: PartnerPublishedDocument[];
    };

// Stamped into additional_data so a partner session stays recognisable across reloads.
export type PartnerContext = {
  handoff_id: string;
  origin: string;
  published_at?: number;
};

export type PartnerCommandHandlers = {
  createSession: (args: {
    session_id?: string;
    templates?: string[];
    language_hint?: string[];
    patient_details?: PatientDetails;
    title?: string;
    partner_additional_data?: Record<string, unknown>;
    partner_context: PartnerContext;
  }) => Promise<string | null>;
  goToNewSession: () => void;
};
