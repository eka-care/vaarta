"""
Generic emit tools — one BaseTool per SectionKind.

Each tool binds a `KIND` + `PAYLOAD_MODEL`; the base class derives the
input schema from the payload model and handles state mutation. Domain
modes (scribe/modes/<mode>/) subclass _GenericEmitTool for their own
kinds and register them in their ModeProfile; the engine does not change.
"""

from typing import Any, ClassVar, Dict, Optional, Type

from echo.tools import BaseTool
from scribe.core.custom_logger import get_logger
from pydantic import BaseModel, ValidationError

from ..payloads import (
    KeyValuePayload,
    ListPayload,
    NarrativePayload,
    Section,
    SectionKind,
    SectionStatus,
    TablePayload,
)
from ..state import ScribeState
from ..state_ops import apply_section_to_state

logger = get_logger(__name__)


def _build_input_schema(payload_model: Type[BaseModel]) -> Dict[str, Any]:
    return {
        "type": "object",
        "required": ["key", "display_name", "payload", "order"],
        "additionalProperties": False,
        "properties": {
            "key": {
                "type": "string",
                "pattern": r"^[a-z][a-z0-9_]*$",
                "description": (
                    "Stable section identifier; slug(display_name) — lowercase "
                    "letters, digits, and underscores only."
                ),
            },
            "display_name": {
                "type": "string",
                "minLength": 1,
                "description": "Heading text verbatim from the user's template.",
            },
            "payload": payload_model.model_json_schema(),
            "order": {
                "type": "integer",
                "minimum": 0,
                "description": "0-indexed render order within the note.",
            },
        },
    }


def _resolve_scribe_state(tool_context: Optional[Dict[str, Any]]):
    if tool_context is None:
        return "Error: tool_context missing (server bug)."
    state = tool_context.get("scribe_state")
    if not isinstance(state, ScribeState):
        return (
            f"Error: tool_context['scribe_state'] is "
            f"{type(state).__name__}, expected ScribeState."
        )
    return state


class _GenericEmitTool(BaseTool):
    """Base for kind-specific emit tools.

    Subclasses set:
        name            — Anthropic tool name (snake_case)
        KIND            — SectionKind value bound to this tool
        PAYLOAD_MODEL   — Pydantic model class for the payload

    `description` is NOT set per catalog subclass: ToolCatalog.instantiate()
    renders it from tool_prompts.yaml at runtime (the single source of truth
    for the LLM-facing prose).
    """

    KIND: ClassVar[SectionKind]
    PAYLOAD_MODEL: ClassVar[Type[BaseModel]]
    # Construction placeholder; overwritten from tool_prompts.yaml for every
    # catalog tool by ToolCatalog.instantiate().
    description = ""

    @property
    def input_schema(self) -> Dict[str, Any]:
        return _build_input_schema(self.PAYLOAD_MODEL)

    async def run(
        self,
        key: str,
        display_name: str,
        payload: Dict[str, Any],
        order: int,
        tool_context: Optional[Dict[str, Any]] = None,
        **_unused: Any,
    ) -> str:
        state = _resolve_scribe_state(tool_context)
        if isinstance(state, str):
            return state

        try:
            self.PAYLOAD_MODEL.model_validate(payload)
        except ValidationError as e:
            return (
                f"Error: payload does not match {self.KIND.value} schema. "
                f"Validation errors: {e.errors()}. Re-emit with the correct shape."
            )

        try:
            section = Section(
                key=key,
                display_name=display_name,
                kind=self.KIND,
                payload=payload,
                order=order,
                status=SectionStatus(state="ready"),
            )
        except ValidationError as e:
            return f"Error: invalid Section shell. Validation errors: {e.errors()}."

        apply_section_to_state(state, section)
        logger.info(
            f"{self.name}: section emitted",
            key=key,
            kind=self.KIND.value,
            order=order,
            sections_count=len(state.sections),
            severity="medium",
        )
        return f"ok — section {key!r} emitted via {self.name}"

class ListTool(_GenericEmitTool):
    name = "add_list"
    KIND = SectionKind.LIST
    PAYLOAD_MODEL = ListPayload

class TableTool(_GenericEmitTool):
    name = "add_table"
    KIND = SectionKind.TABLE
    PAYLOAD_MODEL = TablePayload

class KeyValueTool(_GenericEmitTool):
    name = "add_key_value"
    KIND = SectionKind.KEY_VALUE
    PAYLOAD_MODEL = KeyValuePayload


class NarrativeTool(_GenericEmitTool):
    name = "add_narrative"
    KIND = SectionKind.NARRATIVE
    PAYLOAD_MODEL = NarrativePayload

ALL_GENERIC_TOOLS: Dict[SectionKind, Type[_GenericEmitTool]] = {
    SectionKind.LIST: ListTool,
    SectionKind.TABLE: TableTool,
    SectionKind.KEY_VALUE: KeyValueTool,
    SectionKind.NARRATIVE: NarrativeTool,
}

# switch for turning off tools in every mode (empty by default; tool names)
DISABLED_TOOLS: frozenset = frozenset()

# name-keyed registry of the GENERIC tools only. The active mode's full
# registry (generic + domain tools) is scribe.structuring.tools.catalog.name_to_tool().
NAME_TO_TOOL: Dict[str, Type[_GenericEmitTool]] = {
    cls.name: cls
    for cls in (
        ListTool,
        TableTool,
        KeyValueTool,
        NarrativeTool,
    )
    if cls.name not in DISABLED_TOOLS
}
