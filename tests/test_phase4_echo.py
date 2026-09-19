"""Phase 4: echo providers — file prompts, Sarvam registration, openai_compatible."""

import pytest


def test_file_prompt_provider_variable_semantics(tmp_path, monkeypatch):
    (tmp_path / "my_agent.md").write_text(
        'You are {{role_name}}. Output JSON like {"a": 1, "b": {{count}}}.'
    )
    from echo.prompts.file_provider import FilePromptProvider

    provider = FilePromptProvider(prompt_dir=str(tmp_path))
    import asyncio

    fetched = asyncio.run(
        provider.get_prompt("my_agent", prompt_variables={"role_name": "a scribe", "count": 3})
    )
    desc = fetched.agent_prompt.task.description
    assert "You are a scribe." in desc
    # literal JSON braces must survive (str.format would have crashed/mangled)
    assert '{"a": 1, "b": 3}' in desc


def test_file_prompt_provider_yaml_and_versions(tmp_path):
    d = tmp_path / "scribe_summary_agent"
    d.mkdir()
    (d / "1.yaml").write_text("prompt: v1 body\nrole: old role\n")
    (d / "2.yaml").write_text(
        "prompt: 'Summarize: {{transcript}}'\nrole: summarizer\nexpected_output: a summary\n"
    )
    (d / "production").write_text("2\n")

    from echo.prompts.file_provider import FilePromptProvider
    import asyncio

    provider = FilePromptProvider(prompt_dir=str(tmp_path))
    # slash names flatten to the folder name
    fetched = asyncio.run(
        provider.get_prompt("scribe/summary/agent", prompt_variables={"transcript": "hi"})
    )
    assert fetched.version == "2"
    assert fetched.agent_prompt.task.description == "Summarize: hi"
    assert fetched.agent_prompt.persona.role == "summarizer"
    assert fetched.agent_prompt.task.expected_output == "a summary"

    old = asyncio.run(provider.get_prompt("scribe/summary/agent", version="1"))
    assert old.agent_prompt.task.description == "v1 body"


def test_file_prompt_provider_missing_raises(tmp_path):
    from echo.prompts.base import PromptFetchError
    from echo.prompts.file_provider import FilePromptProvider
    import asyncio

    with pytest.raises(PromptFetchError):
        asyncio.run(FilePromptProvider(prompt_dir=str(tmp_path)).get_prompt("nope"))


@pytest.mark.parametrize("mode", ["general", "medical"])
def test_seeded_prompts_resolve(monkeypatch, mode):
    """Every checked-in agent prompt of every mode
    (scribe/modes/<mode>/prompts/*.md) must load and parse through scribe's
    file prompt loader."""
    from scribe_core.settings import get_settings
    from scribe.modes import get_mode_profile, reset_mode_profile
    from scribe.prompts.prompt_files import load_parsed_prompt_from_file

    monkeypatch.setenv("APP_MODE", mode)
    get_settings.cache_clear()
    reset_mode_profile()
    try:
        files = sorted(get_mode_profile().prompts_dir.glob("*.md"))
        assert files, f"no prompt files checked in for mode {mode}"
        for f in files:
            parsed = load_parsed_prompt_from_file(f.stem)
            assert parsed is not None, f"prompt failed to load/parse: {f.name}"
    finally:
        get_settings.cache_clear()
        reset_mode_profile()



def test_sarvam_provider_registered(monkeypatch):
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    from echo.audio.transcription.config import TranscriberConfig
    from echo.audio.transcription.factory import get_transcriber

    config = TranscriberConfig(provider="sarvam", language="hi")
    assert config.model == "saarika:v2.5"  # gemini env default swapped out
    t = get_transcriber(config)
    assert t.base_url is None  # sarvamai SDK default endpoint (v0.3.10)
    assert t._language_code() == "hi-IN"


def test_openai_compatible_llm(monkeypatch):
    monkeypatch.delenv("ECHO_LLM_BASE_URL", raising=False)
    from echo.llm import LLMConfig, get_llm

    llm = get_llm(
        LLMConfig(
            provider="openai_compatible",
            model="qwen3:14b",
            base_url="http://vllm.local:8000/v1",
        )
    )
    assert llm.base_url == "http://vllm.local:8000/v1"
    assert llm._uses_max_completion_tokens() is False
    assert llm._supports_reasoning_effort() is False
    assert llm.client.base_url  # constructs without a real key


def test_prompt_factory_file_mode(monkeypatch, tmp_path):
    monkeypatch.setenv("ECHO_PROMPT_PROVIDER", "file")
    monkeypatch.setenv("ECHO_PROMPT_DIR", str(tmp_path))
    from echo.prompts.factory import get_prompt_provider, reset_prompt_provider

    reset_prompt_provider()
    from echo.prompts.file_provider import FilePromptProvider

    assert isinstance(get_prompt_provider(), FilePromptProvider)
    reset_prompt_provider()
