"""
File-backed prompt service.

Prompts live as .md files in scribe/modes/<APP_MODE>/prompts/ and are loaded
into an in-memory cache on first use (template *content* lives in the database; these
files carry only agent system prompts). Variables use {{name}} placeholders.
"""

from typing import Any, Optional

from scribe.core.custom_logger import get_logger

from .prompt_files import load_parsed_prompt_from_file
from .prompt_parser import ParsedAgentPrompt

logger = get_logger(__name__)

# agent key -> prompt file name (without .md) in scribe/modes/<mode>/prompts/
AGENT_PROMPT_NAMES = {
    "agentic_ui_v2": "agentic_ui_system_prompt_v2",
    "template_authoring": "template_authoring_agent",
}


class FilePromptService:
    """Loads and parses agent prompts from disk, with an in-memory raw cache."""

    def __init__(self) -> None:
        # (prompt_name, frozenset(variables.items())) is NOT cacheable — variables
        # change per request — so cache nothing beyond what prompt_files reads.
        # Parsed results are cheap; raw file reads hit the OS page cache. Kept
        # simple on purpose.
        pass

    def get_parsed_agent_prompt(
        self, agent_key: str, response_type: str = "markdown", **variables: Any
    ) -> ParsedAgentPrompt:
        """Load + parse the prompt for `agent_key`, substituting variables.

        Raises FileNotFoundError when the prompt file is missing or empty.
        """
        prompt_name = AGENT_PROMPT_NAMES.get(agent_key, agent_key)
        parsed = load_parsed_prompt_from_file(prompt_name, **variables)
        if parsed is not None:
            return parsed
        raise FileNotFoundError(
            f"Prompt not found for agent '{agent_key}' "
            f"(missing or invalid file: scribe/modes/<mode>/prompts/{prompt_name}.md)"
        )


_prompt_service: Optional[FilePromptService] = None


def get_prompt_service() -> FilePromptService:
    global _prompt_service
    if _prompt_service is None:
        _prompt_service = FilePromptService()
    return _prompt_service
