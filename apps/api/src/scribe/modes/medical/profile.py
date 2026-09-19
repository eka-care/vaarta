"""Medical mode — clinical scribe for doctor–patient consultations.

The four generic tools plus the eight clinical table tools. Importing this
module also registers the clinical payload models with KIND_TO_PAYLOAD.
"""

from scribe.modes import ModeProfile
from scribe.structuring.tools.generic import (
    KeyValueTool,
    ListTool,
    NarrativeTool,
    TableTool,
)

from .tools.clinical import CLINICAL_TOOLS

PROFILE = ModeProfile(
    name="medical",
    tool_classes={
        cls.name: cls
        for cls in (ListTool, TableTool, KeyValueTool, NarrativeTool, *CLINICAL_TOOLS)
    },
)
