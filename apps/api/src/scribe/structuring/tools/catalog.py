from dataclasses import dataclass
from functools import lru_cache
from typing import Dict, List, Optional, Type

import yaml
from scribe.core.custom_logger import get_logger
from pydantic import BaseModel, ConfigDict

from scribe.modes import get_mode_profile

from .generic import DISABLED_TOOLS, _GenericEmitTool

logger = get_logger(__name__)


def name_to_tool() -> Dict[str, Type[_GenericEmitTool]]:
    """Emit-tool registry of the active mode (name -> class, prompt order)."""
    return {
        name: cls
        for name, cls in get_mode_profile().tool_classes.items()
        if name not in DISABLED_TOOLS
    }


class RouteAway(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str
    tool: str


class ToolPromptEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    when_to_use: str
    rules: Optional[str] = None
    mandatory_content: List[str] = []
    routes_away: List[RouteAway] = []


class ToolPromptsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int
    preamble: str
    fallback_rule: str
    mandatory_selection_header: str
    tools: Dict[str, ToolPromptEntry]


@lru_cache(maxsize=1)
def load_tool_prompts() -> ToolPromptsConfig:
    """The active mode's tool_prompts.yaml, cross-checked against its tools."""
    path = get_mode_profile().tool_prompts_path
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        config = ToolPromptsConfig.model_validate(raw)
    except Exception as e:
        raise RuntimeError(f"Failed to load tool prompts from {path}: {e}") from e

    # Disabled tools keep their yaml entries so re-enabling is a one-line change.
    registry = name_to_tool()
    missing = set(registry) - set(config.tools)
    unknown = set(config.tools) - set(registry) - DISABLED_TOOLS
    if missing or unknown:
        raise RuntimeError(
            f"{path} out of sync with the mode's tool registry: "
            f"missing={sorted(missing)}, unknown={sorted(unknown)}"
        )
    return config


@dataclass(frozen=True)
class ToolSpec:
    name: str
    tool_cls: Type[_GenericEmitTool]
    prompt: ToolPromptEntry


class ToolCatalog:

    def __init__(self, config: Optional[ToolPromptsConfig] = None) -> None:
        self._config = config or load_tool_prompts()
        self._registry = name_to_tool()

    def _spec(self, name: str) -> ToolSpec:
        return ToolSpec(
            name=name,
            tool_cls=self._registry[name],
            prompt=self._config.tools[name],
        )

    def all_specs(self) -> List[ToolSpec]:
        """Every emit tool of the active mode — the full default toolset."""
        return [self._spec(name) for name in self._registry]

    def render_tools_available(self, specs: List[ToolSpec]) -> str:
        """Render the {{tools_available}} prompt block for the enabled set."""
        enabled = {s.name for s in specs}
        parts = [self._config.preamble.strip(), self._config.fallback_rule.strip()]

        for spec in specs:
            parts.append(self._render_tool_block(spec, enabled))

        mandatory_lines = [
            f"- {content} → {spec.name}"
            for spec in specs
            for content in spec.prompt.mandatory_content
        ]
        if mandatory_lines:
            parts.append(
                self._config.mandatory_selection_header.strip()
                + "\n"
                + "\n".join(mandatory_lines)
            )

        return "\n\n".join(parts)

    def _render_tool_block(
        self, spec: ToolSpec, enabled: set, include_heading: bool = True
    ) -> str:
        lines = [f"### {spec.name}"] if include_heading else []
        lines.append(spec.prompt.summary.strip())
        lines.append("When to use: " + spec.prompt.when_to_use.strip())
        if spec.prompt.rules:
            lines.append("Rules: " + spec.prompt.rules.strip())
        redirects = [
            f"- for {r.content} use {r.tool}"
            for r in spec.prompt.routes_away
            if r.tool in enabled
        ]
        if redirects:
            lines.append("Do NOT use this tool:\n" + "\n".join(redirects))
        return "\n".join(lines)

    def instantiate(self, specs: List[ToolSpec]) -> List[_GenericEmitTool]:
        enabled = {s.name for s in specs}
        tools: List[_GenericEmitTool] = []
        for spec in specs:
            tool = spec.tool_cls()

            tool.description = self._render_tool_block(
                spec, enabled, include_heading=False
            )
            tools.append(tool)
        return tools


_catalog: Optional[ToolCatalog] = None


def get_tool_catalog() -> ToolCatalog:
    global _catalog
    if _catalog is None:
        _catalog = ToolCatalog()
    return _catalog


def reset_tool_catalog() -> None:
    """Drop cached catalog + prompts (tests switch APP_MODE at runtime)."""
    global _catalog
    _catalog = None
    load_tool_prompts.cache_clear()
