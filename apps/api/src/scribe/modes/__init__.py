"""
Product modes — the domain-specific half of the scribe.

The structuring engine (scribe/structuring/) is domain-agnostic: it runs an
AG-UI agent that emits note sections through tools. Everything that makes a
deployment a *meeting* scribe or a *clinical* scribe lives under one mode
folder here:

    modes/<mode>/
        profile.py               ModeProfile: which emit tools exist
        prompts/*.md             agent system prompts (structuring, authoring)
        tool_prompts.yaml        per-tool prose rendered into the system prompt
        seed_data.yaml           default template directory (scripts/setup.py)

APP_MODE (Settings.app_mode) selects the folder; general is the default.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional, Type

MODES_DIR = Path(__file__).resolve().parent
SUPPORTED_MODES = ("general", "medical")


@dataclass(frozen=True)
class ModeProfile:
    """Everything the engine needs to know about a product mode."""

    name: str
    # name -> tool class, in prompt order; every run gets all of them
    tool_classes: Dict[str, Type] = field(default_factory=dict)

    @property
    def root(self) -> Path:
        return MODES_DIR / self.name

    @property
    def prompts_dir(self) -> Path:
        return self.root / "prompts"

    @property
    def tool_prompts_path(self) -> Path:
        return self.root / "tool_prompts.yaml"

    @property
    def seed_path(self) -> Path:
        return self.root / "seed_data.yaml"


_profile: Optional[ModeProfile] = None


def _load(name: str) -> ModeProfile:
    if name == "general":
        from .general.profile import PROFILE
    elif name == "medical":
        from .medical.profile import PROFILE
    else:
        raise ValueError(
            f"Unsupported APP_MODE {name!r}; expected one of {SUPPORTED_MODES}"
        )
    return PROFILE


def get_mode_profile() -> ModeProfile:
    """The active mode, resolved once from Settings.app_mode (APP_MODE)."""
    global _profile
    if _profile is None:
        from scribe_core.settings import get_settings

        _profile = _load(get_settings().app_mode)
    return _profile


def reset_mode_profile() -> None:
    """Forget the cached mode (tests switch APP_MODE at runtime)."""
    global _profile
    _profile = None
