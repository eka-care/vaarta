"""
Section-level data models for the AG-UI scribe state.

Four generic render kinds — LIST, TABLE, KEY_VALUE, NARRATIVE — keep the
payload surface minimal while staying expressive enough for any note
section, whatever the domain (meetings, interviews, clinical, finance).
The LLM picks the kind that best fits the template heading and fills the
payload with markdown content.

Domain kinds (the clinical ones below) are table-shaped variants with
canonical columns; their payload models and emit tools live with the mode
that uses them (scribe/modes/medical/tools/) and register into
KIND_TO_PAYLOAD when that mode is loaded. The enum lists every kind the
frontend may receive so a persisted state from either mode always parses.
"""

from enum import Enum
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "ColumnType",
    "KIND_TO_PAYLOAD",
    "require_columns",
    "KeyValueItem",
    "KeyValuePayload",
    "ListPayload",
    "NarrativePayload",
    "Section",
    "SectionKind",
    "SectionStatus",
    "StrictModel",
    "TableColumn",
    "TablePayload",
    "validate_section_payload",
]


class StrictModel(BaseModel):
    """Pydantic base that rejects unknown fields so LLM-emitted shape
    drift fails validation loudly rather than silently dropping data."""

    model_config = ConfigDict(extra="forbid")


ColumnType = Literal["text", "markdown", "number", "date"]


class TableColumn(StrictModel):
    """One column header in a TABLE section.

    `key` is the stable identifier referenced by row dicts. `label` is
    the human-readable header rendered in the UI. `type` hints the cell
    editor (text input, number input, date picker, or markdown editor);
    defaults to "markdown" so cells can carry rich content.
    """

    key: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    label: str = Field(min_length=1)
    type: ColumnType = "markdown"


class SectionKind(str, Enum):
    # generic (every mode)
    LIST = "LIST"
    TABLE = "TABLE"
    KEY_VALUE = "KEY_VALUE"
    NARRATIVE = "NARRATIVE"
    # clinical (medical mode) — all table-shaped with canonical columns
    MEDICATION_TABLE = "MEDICATION_TABLE"
    PROCEDURES = "PROCEDURES"
    LAB_RESULTS = "LAB_RESULTS"
    LAB_INVESTIGATIONS = "LAB_INVESTIGATIONS"
    VITAL_TABLE = "VITAL_TABLE"
    PATIENT_MEDICAL_HISTORY = "PATIENT_MEDICAL_HISTORY"
    DIAGNOSIS = "DIAGNOSIS"
    EXAMINATION_FINDINGS = "EXAMINATION_FINDINGS"


class ListPayload(StrictModel):
    """Bulleted/numbered list. Each item is a markdown string — the LLM
    decides what structure (bold, links, inline code) to use per item."""

    items: List[str] = []


class TablePayload(StrictModel):
    """Tabular section. Each row is a dict keyed by `headers[*].key`."""

    headers: List[TableColumn] = []
    rows: List[Dict[str, str]] = []


def require_columns(headers: List[TableColumn], required: List[str], model_name: str) -> None:
    """Shared validator for table kinds with canonical columns."""
    present = {h.key for h in headers}
    missing = [k for k in required if k not in present]
    if missing:
        raise ValueError(
            f"{model_name}.headers is missing required column key(s): {missing}. "
            f"Required keys (in this order): {required}. Extra columns are "
            "allowed when the transcript supplies that data."
        )


class KeyValueItem(StrictModel):
    key: str = Field(min_length=1)
    value: str = ""


class KeyValuePayload(StrictModel):
    """Definition-list / detail-card section. `value` is markdown."""

    items: List[KeyValueItem] = []


class NarrativePayload(StrictModel):
    """Free-form markdown section — summary, discussion, plan, notes, etc."""

    markdown: str = ""


class SectionStatus(BaseModel):
    state: Literal[
        "pending", "extracting", "awaiting_input", "ready", "saved", "error"
    ] = "pending"
    error: Optional[str] = None


class Section(BaseModel):
    """One render unit in the note.

    `key` is the JSON Pointer anchor used in STATE_DELTA ops and must be
    a slug (lowercase + underscores). `display_name` is the heading the
    FE renders verbatim. `kind` drives both server-side payload
    validation and FE component selection. `payload` is a free-form
    dict — validate via validate_section_payload(kind, payload).
    """

    key: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    display_name: str = Field(min_length=1)
    kind: SectionKind
    payload: Dict[str, Any] = {}
    order: int = Field(ge=0)
    status: SectionStatus = SectionStatus()
    edited_by_user: bool = False


# Generic kinds here; a mode adds its own entries when its profile loads
# (see scribe/modes/medical/tools/payloads.py).
KIND_TO_PAYLOAD: Dict[SectionKind, type[BaseModel]] = {
    SectionKind.LIST: ListPayload,
    SectionKind.TABLE: TablePayload,
    SectionKind.KEY_VALUE: KeyValuePayload,
    SectionKind.NARRATIVE: NarrativePayload,
}


def validate_section_payload(kind: SectionKind, payload: Dict[str, Any]) -> BaseModel:
    """Validate `payload` against the Pydantic model for `kind`.

    Raises pydantic.ValidationError if the payload doesn't match the
    kind's schema. Tool implementations catch the error and return a
    structured string the LLM can act on.
    """
    model_cls = KIND_TO_PAYLOAD.get(kind)
    if model_cls is None:
        raise ValueError(f"No payload model registered for kind: {kind!r}")
    return model_cls.model_validate(payload)
