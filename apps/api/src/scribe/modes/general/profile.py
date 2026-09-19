"""General (non-medical) mode — meeting / interview / notes scribe.

Only the four generic render tools; the template's `desc` steers which
shape each heading takes.
"""

from scribe.modes import ModeProfile
from scribe.structuring.tools.generic import (
    KeyValueTool,
    ListTool,
    NarrativeTool,
    TableTool,
)

PROFILE = ModeProfile(
    name="general",
    tool_classes={
        cls.name: cls for cls in (ListTool, TableTool, KeyValueTool, NarrativeTool)
    },
)
