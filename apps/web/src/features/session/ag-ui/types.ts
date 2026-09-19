/**
 * FE mirrors of the AG-UI ScribeState shapes from the backend
 * (apps/api/src/scribe/structuring/payloads.py).
 *
 * Four generic render kinds — LIST, TABLE, KEY_VALUE, NARRATIVE — plus the
 * clinical kinds the medical mode emits. Every clinical kind is table-shaped
 * ({headers, rows}) and renders through the table body; the kind is kept on
 * the section so the backend can re-validate edits later.
 */

export type GenericSectionKind = 'LIST' | 'TABLE' | 'KEY_VALUE' | 'NARRATIVE';

export type ClinicalSectionKind =
  | 'MEDICATION_TABLE'
  | 'PROCEDURES'
  | 'LAB_RESULTS'
  | 'LAB_INVESTIGATIONS'
  | 'VITAL_TABLE'
  | 'PATIENT_MEDICAL_HISTORY'
  | 'DIAGNOSIS'
  | 'EXAMINATION_FINDINGS';

export type SectionKind = GenericSectionKind | ClinicalSectionKind;

// Kinds whose payload is {headers, rows}: TABLE and every clinical kind.
export function isTableKind(kind: string): boolean {
  return kind !== 'LIST' && kind !== 'KEY_VALUE' && kind !== 'NARRATIVE';
}

export type SectionStatusState =
  | 'pending'
  | 'extracting'
  | 'awaiting_input'
  | 'ready'
  | 'saved'
  | 'error';

export type SectionStatus = {
  state: SectionStatusState;
  error?: string | null;
};

export type Section = {
  key: string;
  display_name: string;
  kind: SectionKind;
  payload: Record<string, unknown>;
  order: number;
  status: SectionStatus;
  edited_by_user?: boolean;
};

export type ColumnType = 'text' | 'markdown' | 'number' | 'date' | 'pills';

export type TableColumn = {
  key: string;
  label: string;
  type: ColumnType;
};

export type ListPayload = {
  items: string[];
};

export type TablePayload = {
  headers: TableColumn[];
  rows: Record<string, unknown>[];
};

export type KeyValueItem = {
  key: string;
  value: string;
};

export type KeyValuePayload = {
  items: KeyValueItem[];
};

export type NarrativePayload = {
  markdown: string;
};

export type ScribeState = {
  template_id: string;
  txn_id: string;
  document_id: string;
  transcript: string;
  sections: Section[];
  omitted_sections: string[];
  pending_tool_call_id?: string | null;
};

export type StreamPhase = 'idle' | 'connecting' | 'streaming' | 'finished' | 'error';

// AG-UI text messages (TEXT_MESSAGE_START/CONTENT/END) accumulated by
// message_id. `done` flips on TEXT_MESSAGE_END.
export type StreamMessage = {
  id: string;
  role: string;
  content: string;
  done: boolean;
};

// AG-UI tool calls. `args` is the streamed JSON string (may be partial
// until TOOL_CALL_END). `result` is set on TOOL_CALL_RESULT.
export type StreamToolCall = {
  id: string;
  name: string;
  args: string;
  result?: string;
  parent_message_id?: string;
  status: 'streaming' | 'ended' | 'completed';
};
