"""Product modes: APP_MODE picks the tool registry, prompts and seeds."""

import pytest
import yaml
from pydantic import ValidationError

from scribe.modes import SUPPORTED_MODES, get_mode_profile, reset_mode_profile
from scribe.structuring.payloads import KIND_TO_PAYLOAD, SectionKind
from scribe.structuring.tools.catalog import (
    ToolCatalog,
    load_tool_prompts,
    name_to_tool,
    reset_tool_catalog,
)
from scribe.structuring.tools.generic import NAME_TO_TOOL

GENERIC = ["add_list", "add_table", "add_key_value", "add_narrative"]
CLINICAL = [
    "add_medication_table",
    "add_procedures",
    "add_lab_results",
    "add_vital_table",
    "add_patient_medical_history",
    "add_diagnosis",
    "add_examination_findings",
    "add_lab_investigations",
]


@pytest.fixture
def mode(monkeypatch):
    """Switch APP_MODE for one test and drop every cached view of it."""

    def _set(name: str):
        from scribe_core.settings import get_settings

        monkeypatch.setenv("APP_MODE", name)
        get_settings.cache_clear()
        reset_mode_profile()
        reset_tool_catalog()
        return get_mode_profile()

    yield _set
    from scribe_core.settings import get_settings

    get_settings.cache_clear()
    reset_mode_profile()
    reset_tool_catalog()


def test_default_mode_is_general(mode):
    from scribe_core.settings import get_settings

    get_settings.cache_clear()
    reset_mode_profile()
    assert get_mode_profile().name == "general"
    assert list(name_to_tool()) == GENERIC == list(NAME_TO_TOOL)


def test_unknown_mode_rejected(monkeypatch):
    from scribe_core.settings import get_settings

    monkeypatch.setenv("APP_MODE", "legal")
    get_settings.cache_clear()
    with pytest.raises(ValidationError):
        get_settings()
    get_settings.cache_clear()


@pytest.mark.parametrize("name", SUPPORTED_MODES)
def test_mode_assets_exist_and_are_consistent(mode, name):
    profile = mode(name)
    assert profile.name == name
    assert (profile.prompts_dir / "agentic_ui_system_prompt_v2.md").is_file()
    assert (profile.prompts_dir / "template_authoring_agent.md").is_file()
    assert profile.seed_path.is_file()
    # tool_prompts.yaml must cover exactly the mode's registry (startup check)
    config = load_tool_prompts()
    assert set(config.tools) == set(name_to_tool())
    for tool_name, entry in config.tools.items():
        for route in entry.routes_away:
            assert route.tool in name_to_tool(), f"{tool_name} -> {route.tool}"
    # seeds parse and every template has the fields setup.py upserts
    data = yaml.safe_load(profile.seed_path.read_text())
    assert data["seed_mode"] in ("append", "replace")
    assert data["templates"], "seed file has no templates"
    for tmpl in data["templates"]:
        assert {"id", "title", "type", "desc"} <= set(tmpl)


def test_medical_mode_registers_clinical_tools(mode):
    mode("medical")
    assert list(name_to_tool()) == GENERIC + CLINICAL
    catalog = ToolCatalog()
    tools = catalog.instantiate(catalog.all_specs())
    assert [t.name for t in tools] == GENERIC + CLINICAL
    assert all(t.description for t in tools)
    rendered = catalog.render_tools_available(catalog.all_specs())
    assert "add_medication_table" in rendered
    assert "Mandatory tool selection" in rendered
    for kind in (
        SectionKind.MEDICATION_TABLE,
        SectionKind.VITAL_TABLE,
        SectionKind.DIAGNOSIS,
        SectionKind.LAB_INVESTIGATIONS,
    ):
        assert kind in KIND_TO_PAYLOAD


def test_general_mode_prompt_never_mentions_the_clinical_tools(mode):
    mode("general")
    catalog = ToolCatalog()
    rendered = catalog.render_tools_available(catalog.all_specs())
    for name in CLINICAL:
        assert name not in rendered


def test_clinical_payloads_require_canonical_columns(mode):
    mode("medical")
    from scribe.modes.medical.tools.payloads import (
        MedicationTablePayload,
        VitalTablePayload,
    )

    with pytest.raises(ValidationError, match="dosage"):
        MedicationTablePayload.model_validate(
            {"headers": [{"key": "drug_name", "label": "Drug"}], "rows": []}
        )
    ok = VitalTablePayload.model_validate(
        {
            "headers": [
                {"key": k, "label": k}
                for k in ["vital_name", "value", "unit", "normal_range", "notes", "time"]
            ],
            "rows": [{"vital_name": "BP", "value": "140/90", "unit": "mmHg"}],
        }
    )
    assert ok.rows[0]["value"] == "140/90"


@pytest.mark.asyncio
async def test_clinical_tool_emits_section_into_state(mode):
    mode("medical")
    from scribe.modes.medical.tools.clinical import DiagnosisTool
    from scribe.structuring.state import ScribeState

    state = ScribeState()
    result = await DiagnosisTool().run(
        key="assessment",
        display_name="Assessment",
        order=0,
        payload={
            "headers": [
                {"key": k, "label": k} for k in ["diagnosis", "since", "status", "note"]
            ],
            "rows": [{"diagnosis": "Viral fever", "status": "provisional"}],
        },
        tool_context={"scribe_state": state},
    )
    assert result.startswith("ok")
    assert state.sections[0].kind == SectionKind.DIAGNOSIS
    assert state.sections[0].payload["rows"][0]["diagnosis"] == "Viral fever"
