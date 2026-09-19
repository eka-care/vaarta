"""
Clinical section payloads — the medical mode's table kinds.

Every clinical kind is a TABLE (headers + string-celled rows) whose `headers`
MUST include a canonical column set, in the documented order. The LLM may ADD
extra columns after the canonical ones when the transcript carries that data.
Only the first column carries required data per row; the rest are left blank
('') when unspecified. Rows are emitted only for items actually mentioned.

Ported from voice2rx-be with the catalog enrichment removed: nothing here
searches a formulary, adds codes, or rewrites what was dictated. The section
streams out exactly as the model emitted it.
"""

from typing import ClassVar, Dict, List

from pydantic import model_validator

from scribe.structuring.payloads import (
    KIND_TO_PAYLOAD,
    SectionKind,
    StrictModel,
    TableColumn,
    require_columns,
)

__all__ = [
    "CLINICAL_KIND_TO_PAYLOAD",
    "DiagnosisPayload",
    "ExaminationFindingsPayload",
    "LabInvestigationsPayload",
    "LabResultsPayload",
    "MedicationTablePayload",
    "PatientMedicalHistoryPayload",
    "ProceduresPayload",
    "VitalTablePayload",
]

MEDICATION_REQUIRED_COLUMNS = ["drug_name", "dosage", "frequency", "duration", "notes"]
PROCEDURES_REQUIRED_COLUMNS = ["procedure_name", "timing", "note"]
LAB_RESULTS_REQUIRED_COLUMNS = ["test_name", "value", "unit", "reference_range", "out_of_range"]
LAB_INVESTIGATIONS_REQUIRED_COLUMNS = ["investigation", "test_on", "repeat_on", "remarks"]
VITAL_REQUIRED_COLUMNS = ["vital_name", "value", "unit", "normal_range", "notes"]
PATIENT_MEDICAL_HISTORY_REQUIRED_COLUMNS = ["condition", "category", "status", "since", "note"]
DIAGNOSIS_REQUIRED_COLUMNS = ["diagnosis", "since", "status", "note"]
EXAMINATION_FINDINGS_REQUIRED_COLUMNS = ["finding", "status", "detail"]


class _CanonicalTablePayload(StrictModel):
    """Table payload whose headers must contain REQUIRED_COLUMNS."""

    REQUIRED_COLUMNS: ClassVar[List[str]] = []

    headers: List[TableColumn] = []
    rows: List[Dict[str, str]] = []

    @model_validator(mode="after")
    def _ensure_required_columns(self):
        require_columns(self.headers, self.REQUIRED_COLUMNS, type(self).__name__)
        return self


class MedicationTablePayload(_CanonicalTablePayload):
    """Prescribed / advised medications. `drug_name` is the complete dictated
    product name including strength ("Dolo 650mg"); `dosage` is the amount
    per intake ("1 tablet")."""

    REQUIRED_COLUMNS = MEDICATION_REQUIRED_COLUMNS


class ProceduresPayload(_CanonicalTablePayload):
    """Procedures or surgeries advised or performed. `timing` is when the
    procedure is advised ("After 3 Days", "Immediately")."""

    REQUIRED_COLUMNS = PROCEDURES_REQUIRED_COLUMNS


class LabResultsPayload(_CanonicalTablePayload):
    """Lab / investigation results WITH values. `out_of_range` flags an
    abnormal result ("high", "low", or "")."""

    REQUIRED_COLUMNS = LAB_RESULTS_REQUIRED_COLUMNS


class LabInvestigationsPayload(_CanonicalTablePayload):
    """Lab tests / radiology ORDERED at this visit, no result yet. `test_on`
    is when to do the test, `repeat_on` when to repeat it, `remarks` carries
    instructions ("fasting", "with contrast")."""

    REQUIRED_COLUMNS = LAB_INVESTIGATIONS_REQUIRED_COLUMNS


class VitalTablePayload(_CanonicalTablePayload):
    """Vital signs (BP, HR, SpO2, temperature, RR, weight, height, BMI...)."""

    REQUIRED_COLUMNS = VITAL_REQUIRED_COLUMNS


class PatientMedicalHistoryPayload(_CanonicalTablePayload):
    """Pre-existing conditions, allergies and lifestyle habits. `category` is
    one of condition / drug_allergy / other_allergy / lifestyle_habit; `status`
    is yes / no (explicit denial) / ""."""

    REQUIRED_COLUMNS = PATIENT_MEDICAL_HISTORY_REQUIRED_COLUMNS


class DiagnosisPayload(_CanonicalTablePayload):
    """Diagnoses / clinical impressions made at this visit. `status` is active /
    provisional / resolved / ruled_out / chronic / ""; no codes are invented."""

    REQUIRED_COLUMNS = DIAGNOSIS_REQUIRED_COLUMNS


class ExaminationFindingsPayload(_CanonicalTablePayload):
    """On-examination findings incl. pertinent negatives. `status` is present /
    absent / normal / abnormal / ""; `detail` carries the qualifiers."""

    REQUIRED_COLUMNS = EXAMINATION_FINDINGS_REQUIRED_COLUMNS


CLINICAL_KIND_TO_PAYLOAD = {
    SectionKind.MEDICATION_TABLE: MedicationTablePayload,
    SectionKind.PROCEDURES: ProceduresPayload,
    SectionKind.LAB_RESULTS: LabResultsPayload,
    SectionKind.LAB_INVESTIGATIONS: LabInvestigationsPayload,
    SectionKind.VITAL_TABLE: VitalTablePayload,
    SectionKind.PATIENT_MEDICAL_HISTORY: PatientMedicalHistoryPayload,
    SectionKind.DIAGNOSIS: DiagnosisPayload,
    SectionKind.EXAMINATION_FINDINGS: ExaminationFindingsPayload,
}

# Make validate_section_payload() aware of the clinical kinds.
KIND_TO_PAYLOAD.update(CLINICAL_KIND_TO_PAYLOAD)
