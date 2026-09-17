"""
Clinical emit tools — one _GenericEmitTool per clinical SectionKind.

Pure validate-and-emit: each tool validates the payload against its kind's
canonical-column model and writes the section into ScribeState. No catalog
lookups, no code resolution, no rewriting of dictated names. `description`
is rendered from the medical mode's tool_prompts.yaml by ToolCatalog.
"""

from scribe.structuring.payloads import SectionKind
from scribe.structuring.tools.generic import _GenericEmitTool

from .payloads import (
    DiagnosisPayload,
    ExaminationFindingsPayload,
    LabInvestigationsPayload,
    LabResultsPayload,
    MedicationTablePayload,
    PatientMedicalHistoryPayload,
    ProceduresPayload,
    VitalTablePayload,
)

__all__ = [
    "CLINICAL_TOOLS",
    "DiagnosisTool",
    "ExaminationFindingsTool",
    "LabInvestigationsTool",
    "LabResultsTool",
    "MedicationTableTool",
    "PatientMedicalHistoryTool",
    "ProceduresTool",
    "VitalTableTool",
]


class MedicationTableTool(_GenericEmitTool):
    name = "add_medication_table"
    KIND = SectionKind.MEDICATION_TABLE
    PAYLOAD_MODEL = MedicationTablePayload


class ProceduresTool(_GenericEmitTool):
    name = "add_procedures"
    KIND = SectionKind.PROCEDURES
    PAYLOAD_MODEL = ProceduresPayload


class LabResultsTool(_GenericEmitTool):
    name = "add_lab_results"
    KIND = SectionKind.LAB_RESULTS
    PAYLOAD_MODEL = LabResultsPayload


class LabInvestigationsTool(_GenericEmitTool):
    name = "add_lab_investigations"
    KIND = SectionKind.LAB_INVESTIGATIONS
    PAYLOAD_MODEL = LabInvestigationsPayload


class VitalTableTool(_GenericEmitTool):
    name = "add_vital_table"
    KIND = SectionKind.VITAL_TABLE
    PAYLOAD_MODEL = VitalTablePayload


class PatientMedicalHistoryTool(_GenericEmitTool):
    name = "add_patient_medical_history"
    KIND = SectionKind.PATIENT_MEDICAL_HISTORY
    PAYLOAD_MODEL = PatientMedicalHistoryPayload


class DiagnosisTool(_GenericEmitTool):
    name = "add_diagnosis"
    KIND = SectionKind.DIAGNOSIS
    PAYLOAD_MODEL = DiagnosisPayload


class ExaminationFindingsTool(_GenericEmitTool):
    name = "add_examination_findings"
    KIND = SectionKind.EXAMINATION_FINDINGS
    PAYLOAD_MODEL = ExaminationFindingsPayload


# Prompt order: the order tool blocks appear in {{tools_available}}.
CLINICAL_TOOLS = (
    MedicationTableTool,
    ProceduresTool,
    LabResultsTool,
    VitalTableTool,
    PatientMedicalHistoryTool,
    DiagnosisTool,
    ExaminationFindingsTool,
    LabInvestigationsTool,
)
