"""
File-based agent prompt loader.
Reads prompt content from the active mode's prompts folder
(scribe/modes/<APP_MODE>/prompts/{prompt_name}.md), substitutes
{{variable_name}} placeholders with provided kwargs, and parses sections.
"""

from pathlib import Path
from typing import Any, Optional

from scribe.core.custom_logger import get_logger
from scribe.modes import get_mode_profile

from .prompt_parser import ParsedAgentPrompt, parse_agent_prompt

logger = get_logger(__name__)


def _prompts_dir() -> Path:
    """Prompt folder of the active mode (scribe/modes/<mode>/prompts)."""
    return get_mode_profile().prompts_dir


def _prompt_name_to_filename(prompt_name: str) -> str:
    """Convert e.g. template/authoring/agent -> template_authoring_agent.md"""
    return prompt_name.replace("/", "_") + ".md"


def _substitute_variables(raw: str, **variables: Any) -> str:
    """Replace {{var_name}} placeholders with values."""
    result = raw
    for key, value in variables.items():
        placeholder = "{{" + key + "}}"
        result = result.replace(placeholder, str(value) if value is not None else "")
    return result


def load_parsed_prompt_from_file(
    prompt_name: str, **variables: Any
) -> Optional[ParsedAgentPrompt]:
    """
    Load prompt content from the active mode's prompts/{prompt_name}.md, substitute variables, parse sections.
    Returns ParsedAgentPrompt or None if file not found or parse yields no content.
    """
    filename = _prompt_name_to_filename(prompt_name)
    path = _prompts_dir() / filename
    if not path.is_file():
        logger.warning("Prompt file not found", path=str(path), prompt_name=prompt_name, severity="medium")
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning(
            "Failed to read prompt file",
            path=str(path),
            error=str(e),
            severity="medium",
        )
        return None
    compiled = _substitute_variables(raw, **variables)
    parsed = parse_agent_prompt(compiled)
    if not any(
        [
            parsed.identity,
            parsed.goal,
            parsed.backstory,
            parsed.task_instructions,
            parsed.user_prompt,
        ]
    ):
        logger.warning(
            "Parsed file prompt has no identity/goal/backstory/task_instructions/user_prompt",
            prompt_name=prompt_name,
            severity="medium",
        )
        return None
    return parsed
