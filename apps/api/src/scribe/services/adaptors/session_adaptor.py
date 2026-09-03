"""
Session Adaptor

Bridges MedScribeAlliance protocol session requests to Voice2Rx
transaction-based backend.

Protocol Sessions ↔ Voice2Rx Transactions:
- POST /sessions → POST /voice/api/v2/transaction/init/{txn_id}
- POST /sessions/{id}/end → POST /voice/api/v2/transaction/commit/{txn_id}
- GET /sessions/{id} → GET /voice/api/v3/status-txn/{txn_id}
"""

from http import HTTPStatus
import os
from fastapi import Request
import orjson
import uuid
import base64
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from scribe.core.custom_logger import get_logger
from scribe.core.utils import parse_additional_data
from scribe.core.exceptions import BadRequestException, ResourceNotFoundException
from scribe.services.session_utils import SESSION_DURATION_SECONDS, compute_session_expires_at, compute_upload_url
from scribe.core.choices import (
    InputLanguage,
    LanguageOutput,
    Transfer,
    VOICE2RX_MODEL_TYPE,
    UserStatus,
    resolve_input_language,
)
from scribe.schemas import (
    CreateSessionRequest,
    CreateSessionResponse,
    SessionStatus,
    EndSessionResponse,
    UploadType,
)
from scribe.services.result_service_v2 import ResultServiceV2
from scribe.services.transaction_service import TransactionService
from scribe.services.config_service import ConfigService
from scribe.core.time_utils import iso_to_epoch

logger = get_logger(__name__)


class SessionAdaptor:
    """
    Adaptor for converting protocol session requests to backend transactions.

    Design Principles:
    1. Stateless - Each method is independent
    2. Extensible - Easy to add new protocol features
    3. Backward Compatible - Works with existing backend without changes
    4. Clear Mapping - Protocol concepts map clearly to backend concepts
    """

    def __init__(
        self,
        transaction_service: Optional[TransactionService] = None,
        config_service: Optional[ConfigService] = None,
        result_service_v2: Optional[ResultServiceV2] = None,
    ):
        """
        Initialize session adaptor with backend services.

        Args:
            transaction_service: Backend transaction service
            config_service: Backend configuration service
            result_service_v2: Result service V2 (polls ekascribe_document)
        """
        self.transaction_service = transaction_service or TransactionService()
        self.result_service_v2 = result_service_v2 or ResultServiceV2()
        self.config_service = config_service or ConfigService()

        # Protocol configuration
        self.s3_vaded_bucket = os.getenv("S3_VADED_BUCKET_NAME", "voice-records")
        # self.s3_vaded_bucket = "m-pp-voice2rx"
        self.s3_non_vaded_bucket = os.getenv(
            "S3_NON_VADED_BUCKET_NAME", "voice-records-batch"
        )
        # self.s3_non_vaded_bucket = "api-dev-file-objects"

    def generate_session_id(self) -> str:
        """
        Generate a protocol-compliant session ID.

        Format: ses_{unique_id}
        Length: 16-32 characters

        Returns:
            Session ID string
        """
        unique_id = uuid.uuid4().hex[:20]  # 20 chars + 4 for prefix = 24 total
        return f"ses_{unique_id}"

    def protocol_to_backend_request(
        self,
        request: Request,
        session_id: str,
        session_request: CreateSessionRequest,
        headers: Dict[str, str],
    ) -> Dict[str, Any]:
        """
        Convert protocol CreateSessionRequest to backend transaction init request.

        Maps protocol concepts to backend:
        - templates → output_format_template + request_templates
        - model → model_type
        - language_hint → input_language
        - transcript_language → output_language
        - upload_type → determines transfer mode
        - additional_data → additional_data (pass-through)

        Args:
            session_id: Generated session ID
            request: Protocol session creation request
            headers: Request headers with auth info

        Returns:
            Backend transaction initialization dict
        """
        b_id = headers.get("token_data", {}).get("b-id", "")

        model_type_mapping = {
            "pro": VOICE2RX_MODEL_TYPE.PRO.value,
            "lite": VOICE2RX_MODEL_TYPE.LITE.value,
        }
        model_type = model_type_mapping.get(
            session_request.model if session_request.model else "lite",
            VOICE2RX_MODEL_TYPE.LITE.value,
        )

        # map protocol language hints to backend input_language
        input_languages = []
        if session_request.language_hint:
            if not isinstance(session_request.language_hint, list):
                session_request.language_hint = [session_request.language_hint]
            for lang in session_request.language_hint:
                resolved = resolve_input_language(lang)
                if resolved is not None:
                    input_languages.append(resolved)
                else:
                    logger.warning(
                        f"Unsupported language hint: {lang}, skipping",
                        session_id=session_id,
                        b_id=b_id,
                        severity="medium",
                    )

        if not input_languages:
            raise BadRequestException(
                "language_hint is required on session create; supported "
                "languages: en, hi, en-hi",
                txn_id=session_id,
                b_id=b_id,
            )

        output_language = None
        if session_request.transcript_language:
            if not isinstance(session_request.transcript_language, list):
                session_request.transcript_language = [
                    session_request.transcript_language
                ]
            output_language = (
                resolve_input_language(session_request.transcript_language[0])
                or InputLanguage.EN.value
            )
        
        additional_data = session_request.additional_data or {}
        _flavour = additional_data.get("_flavour", "v2rx")
        output_format_templates = self._map_templates_to_backend(
            session_request.templates, 
            output_language or LanguageOutput.EN_IN.value,
            _flavour
        )

        # determing transfer mode based on upload_type
        transfer_mapping = {
            UploadType.CHUNKED: Transfer.VADED.value,
            UploadType.SINGLE: Transfer.NON_VADED.value,
            UploadType.STREAM: Transfer.VADED.value,
        }
        transfer = transfer_mapping.get(
            session_request.upload_type, Transfer.VADED.value
        )

        # backend will give a fixed backend audio upload url for the session.
        # backend should upload the audio files to the below s3 location for the session internally.
        year = datetime.now().strftime("%Y")
        month = datetime.now().strftime("%m").zfill(2)
        day = datetime.now().strftime("%d").zfill(2)

        s3_url, batch_s3_url = None, None
        if transfer == Transfer.VADED.value:
            date_folder = f"{year[2:]}{month}{day}"
            s3_url = f"s3://{self.s3_vaded_bucket}/{date_folder}/{session_id}/"
        if transfer == Transfer.NON_VADED.value:
            date_folder = f"{year[2:]}{month}{day}"
            s3_url = f"s3://{self.s3_vaded_bucket}/{date_folder}/{session_id}/"
            batch_s3_url = f"s3://{self.s3_non_vaded_bucket}/{b_id}/{b_id}/{session_id}"
        if transfer == Transfer.STREAM.value:
            date_folder = f"{year[2:]}{month}{day}"
            s3_url = f"s3://{self.s3_vaded_bucket}/{date_folder}/{session_id}/"

        # build backend init transaction request
        backend_request = {
            "mode": session_request.session_mode.value,
            "transfer": transfer,
            "model_type": model_type,
            "input_language": input_languages,
            "output_language": output_language,
            "output_format_template": output_format_templates,
            "s3_url": s3_url,
            "batch_s3_url": batch_s3_url,
            # "asr_service": [ASRService.V2RX.value],
            "additional_data": {
                **session_request.additional_data,
                # store protocol-specific metadata
                "_protocol": {
                    "version": "0.1",
                    "upload_type": session_request.upload_type.value,
                    "communication_protocol": session_request.communication_protocol.value,
                    "requested_templates": session_request.templates,
                },
            },
            "model_training_consent": True,
        }

        if session_request.session_details:
            backend_request["session_details"] = session_request.session_details
            patient_oid = session_request.session_details.get("oid")
            if patient_oid:
                backend_request["patient_oid"] = patient_oid

        logger.info(
            "Mapped protocol request to backend",
            session_id=session_id,
            b_id=b_id,
            protocol_templates=session_request.templates,
            backend_model=model_type,
            severity="medium",
        )

        return backend_request

    def _map_templates_to_backend(
        self,
        protocol_templates: List[str],
        output_language: str,
        _flavour: str = "v2rx",
    ) -> List[Dict[str, Any]]:
        backend_templates = []
        for template_id in protocol_templates:
            template_type = "custom"

            backend_templates.append(
                {
                    "template_id": template_id,
                    "language_output": output_language,
                    "template_type": template_type,
                }
            )

        return backend_templates

    def backend_to_protocol_response(
        self,
        session_id: str,
        backend_data: Dict[str, Any],
        request: CreateSessionRequest,
        flavour: str = "",
        version: str = "",
    ) -> CreateSessionResponse:
        created_at = backend_data.get("created_at", "")
        created_at_epoch = iso_to_epoch(created_at)
        expires_at_epoch = compute_session_expires_at(created_at_epoch)

        upload_url = compute_upload_url(
            session_id,
            request.upload_type,
            batch_s3_url=backend_data.get("batch_s3_url"),
            s3_url=backend_data.get("s3_url"),
            b_id=backend_data.get("b_id", ""),
            flavour=flavour,
            version=version,
        )

        storage_provider = "aws" if isinstance(upload_url, dict) else None

        return CreateSessionResponse(
            session_id=session_id,
            status=SessionStatus.CREATED,
            created_at=created_at_epoch,
            expires_at=expires_at_epoch,
            upload_url=upload_url,
            storage_provider=storage_provider,
            session_details=backend_data.get("session_details") or request.session_details,
        )

    async def get_transaction_status(self, session_id: str, b_id: str) -> Dict[str, Any]:
        transaction_data = self.transaction_service.get_transaction(session_id, b_id)
        if transaction_data.get("additional_data", {}):
            transaction_data["additional_data"] = parse_additional_data(
                transaction_data["additional_data"]
            )

        user_status = transaction_data.get("user_status", "")
        # if the transaction user_status is not committed,
        # then return 202 with the audio files and other session api response data.
        # if user have committed the transaction then poll the transaction status endpoint.
        # and return the response according to the result status.
        user_status = transaction_data.get("user_status", "")
        if user_status != UserStatus.COMMIT.value:
            # transcript won't be ready in current flow. as user won't have ended the session yet.
            # but in future we can add the transcript here as soon as it is available in real time.
            status = SessionStatus.INITIALIZED.value
            backend_status_response = {
                **transaction_data,
                "status": status,
                "transcript": "",
                "templates": {},
            }

            return backend_status_response
        else:
            # poll for session documents via ResultServiceV2 (reads ekascribe_document table)
            try:
                response, status_code = (
                    await self.result_service_v2.poll_for_session_documents(
                        transaction_data, b_id
                    )
                )
            except Exception as e:
                logger.error(
                    "Error polling for session documents",
                    session_id=session_id,
                    b_id=b_id,
                    error=str(e),
                    severity="medium",
                )
                raise e
            
            return self._build_backend_status_from_poll(
                session_id, transaction_data, response, status_code
            )

    async def get_document_status(
        self,
        session_id: str,
        b_id: str,
        template_id: Optional[str] = None,
        document_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        transaction_data = self.transaction_service.get_transaction(session_id, b_id)
        if transaction_data.get("additional_data", {}):
            transaction_data["additional_data"] = parse_additional_data(
                transaction_data["additional_data"]
            )

        if not document_id:
            document_id = (
                self.result_service_v2.document_service.get_document_id_by_session_and_template(
                    session_id, template_id
                )
            )
            if not document_id:
                raise ResourceNotFoundException(
                    f"No document found for template '{template_id}'",
                    txn_id=session_id,
                    b_id=b_id,
                )

        response, status_code = await self.result_service_v2.poll_for_document(
            document_id, session_id, b_id
        )

        if status_code == HTTPStatus.NOT_FOUND:
            raise ResourceNotFoundException(
                f"Document '{document_id}' not found for session '{session_id}'",
                txn_id=session_id,
                b_id=b_id,
            )

        return self._build_backend_status_from_poll(
            session_id, transaction_data, response, status_code
        )

    @staticmethod
    def _parse_template_entries(
        entries: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        result_list = []
        for entry in entries:
            value = entry.get("value")
            data = None

            if value:
                try:
                    value = base64.b64decode(value, validate=True).decode("utf-8")
                except Exception:
                    pass

                try:
                    data = orjson.loads(value)
                except Exception:
                    data = value

            inner = {
                "status": entry.get("status"),
                "errors": entry.get("errors"),
                "warnings": entry.get("warnings"),
                "data": data,
                "document_id": entry.get("document_id", ""),
                "document_type": entry.get("document_type", ""),
                "publish": entry.get("publish", {}),
            }
            if "presigned_url" in entry:
                inner["presigned_url"] = entry.get("presigned_url")
                inner["presigned_url_expires_at"] = entry.get(
                    "presigned_url_expires_at"
                )

            result_list.append({entry.get("template_id"): inner})
        return result_list

    def _build_backend_status_from_poll(
        self,
        session_id: str,
        transaction_data: Dict[str, Any],
        response: Dict[str, Any],
        status_code: int,
    ) -> Dict[str, Any]:
        # status code to status mapping
        status_code_to_status = {
            HTTPStatus.OK: SessionStatus.COMPLETED.value,
            HTTPStatus.ACCEPTED: SessionStatus.PROCESSING.value,
            HTTPStatus.PARTIAL_CONTENT: SessionStatus.PARTIAL.value,
            HTTPStatus.INTERNAL_SERVER_ERROR: SessionStatus.FAILED.value,
        }
        status = status_code_to_status.get(
            status_code, SessionStatus.PROCESSING.value
        )
        backend_status_response = {
            **transaction_data,
            "status": status,
            "transcript": "",
            "templates": [],
        }

        template_results = response.get("data", {}).get("template_results", {})

        integration_templates = self._parse_template_entries(
            template_results.get("integration", [])
        )
        if integration_templates:
            backend_status_response["templates"].extend(integration_templates)

        custom_templates = self._parse_template_entries(
            template_results.get("custom", [])
        )
        if custom_templates:
            backend_status_response["templates"].extend(custom_templates)

        # extract transcript from template_results (already included by V2)
        transcript_entries = template_results.get("transcript", [])
        if transcript_entries:
            transcript_value = transcript_entries[0].get("value", "")
            if transcript_value:
                try:
                    # V2 base64-encodes transcript values, decode to plain text
                    backend_status_response["transcript"] = base64.b64decode(
                        transcript_value
                    ).decode("utf-8")
                except Exception as e:
                    logger.error(
                        "Error decoding transcript from V2 response",
                        session_id=session_id,
                        error=str(e),
                        severity="critical",
                    )
                    backend_status_response["transcript"] = transcript_value

        return backend_status_response

    def backend_status_to_protocol_response(
        self,
        session_id: str,
        backend_status: Dict[str, Any],
        flavour: str = "",
        version: str = "",
    ) -> Dict[str, Any]:
        # map backend status to protocol status
        protocol_status = backend_status.get("status", "")

        # extract audio files
        audio_files = backend_status.get("client_uploaded_files", [])
        audio_files_received = len(audio_files)

        # base response data
        response_data = {
            "session_id": session_id,
            "status": protocol_status,
            "created_at": backend_status.get(
                "created_at", datetime.now(timezone.utc).isoformat()
            ),
            "audio_files_received": audio_files_received,
            "audio_files": audio_files,
            "additional_data": backend_status.get("additional_data", {}),
            "session_details": backend_status.get("session_details"),
        }

        if protocol_status != SessionStatus.COMPLETED.value:
            response_data["upload_url"] = compute_upload_url(
                session_id,
                backend_status.get("additional_data", {})
                .get("_protocol", {})
                .get("upload_type", "chunked"),
                batch_s3_url=backend_status.get("batch_s3_url"),
                s3_url=backend_status.get("s3_url"),
                b_id=backend_status.get("b_id", ""),
                flavour=flavour,
                version=version,
            )

        if protocol_status in [SessionStatus.PROCESSING, SessionStatus.INITIALIZED]:
            response_data["expires_at"] = self._calculate_expiry(
                response_data["created_at"]
            )
            response_data["transcript"] = backend_status.get("transcript", None)

        elif protocol_status == SessionStatus.COMPLETED:
            response_data["completed_at"] = backend_status.get("processed_at")
            response_data["model_used"] = self._map_backend_model_to_protocol(
                backend_status.get("model_type")
            )
            response_data["language_detected"] = self._extract_detected_language(
                backend_status
            )
            response_data["transcript"] = backend_status.get("transcript", "")
            # response_data["templates"] = self._map_backend_templates_to_protocol(
            #     backend_status.get("output_template_result", {})
            # )
            response_data["templates"] = backend_status.get("templates", [])

        elif protocol_status == SessionStatus.PARTIAL:
            response_data["completed_at"] = backend_status.get("processed_at")
            response_data["model_used"] = self._map_backend_model_to_protocol(
                backend_status.get("model_type")
            )
            response_data["audio_files_processed"] = audio_files_received  # Simplified
            response_data["transcript"] = backend_status.get("transcript", "")
            response_data["templates"] = backend_status.get("templates", [])
            response_data["processing_errors"] = self._extract_processing_errors(
                backend_status
            )

        elif protocol_status == SessionStatus.EXPIRED:
            response_data["expired_at"] = self._calculate_expiry(
                response_data["created_at"]
            )
            response_data["message"] = "Session expired before processing was initiated"
            response_data["templates"] = {}
            response_data["transcript"] = backend_status.get("transcript", "")

        return response_data

    def _map_backend_model_to_protocol(
        self, backend_model: Optional[str]
    ) -> Optional[str]:
        """Map backend model type to protocol model"""
        if not backend_model:
            return None
        model_mapping = {
            VOICE2RX_MODEL_TYPE.PRO.value: "pro",
            VOICE2RX_MODEL_TYPE.LITE.value: "lite",
        }
        return model_mapping.get(backend_model, "lite")

    def _calculate_expiry(self, created_at: str) -> str:
        """Calculate session expiry time"""
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        expires = created + timedelta(seconds=SESSION_DURATION_SECONDS)
        return expires.isoformat()

    def _extract_detected_language(
        self, backend_status: Dict[str, Any]
    ) -> Optional[str]:
        """Extract detected language from backend status"""
        input_languages = backend_status.get("input_language", [])
        if input_languages:
            # Return first detected language in ISO 639-1 format
            lang = input_languages[0].lower()
            return lang[:2]  # Convert to 2-char code
        return None

    def _extract_processing_errors(
        self, backend_status: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Extract processing errors from backend status"""
        errors = []

        processing_error = backend_status.get("processing_error", {})
        if processing_error and processing_error.get("error"):
            error_detail = processing_error["error"]
            errors.append(
                {
                    "type": error_detail.get("type", "processing_error"),
                    "message": error_detail.get("msg", "Unknown error"),
                }
            )

        return errors

    def create_end_session_response(
        self,
        session_id: str,
        audio_files: List[str],
    ) -> EndSessionResponse:
        return EndSessionResponse(
            session_id=session_id,
            status=SessionStatus.PROCESSING,
            message="Session ended. Processing started.",
            audio_files_received=len(audio_files),
            audio_files=audio_files,
        )
