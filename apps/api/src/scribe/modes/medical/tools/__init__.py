"""Clinical section payloads + emit tools for the medical mode."""

from .clinical import CLINICAL_TOOLS
from .payloads import CLINICAL_KIND_TO_PAYLOAD

__all__ = ["CLINICAL_TOOLS", "CLINICAL_KIND_TO_PAYLOAD"]
