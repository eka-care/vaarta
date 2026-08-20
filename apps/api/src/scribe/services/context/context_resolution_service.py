"""
Context Resolution Service

Resolves context references (past sessions, documents) into a structured
`ResolvedContext` DTO consumed by the agent layer.

- Past sessions -> text transcripts (one per session, with session date)
- Documents     -> text content

Best-effort: individual failures are logged into `warnings` and skipped.
Never raises; callers treat an empty DTO as "no context".
"""

import base64
import os
from typing import Optional

from scribe.core.custom_logger import get_logger
from scribe.repositories.document_orm import EkascribeDocumentORM
from scribe.repositories.transaction_orm import TransactionORM
from scribe.services.context.models import (
    ContextDocumentItem,
    ContextItemKind,
    PastSessionItem,
    ResolvedContext,
)
from scribe.services.transcript_file_service import TranscriptFileService

logger = get_logger(__name__)


class ContextResolutionService:
    def __init__(self):
        self.transcript_file_service = TranscriptFileService()
        self.document_orm = EkascribeDocumentORM()
        self.transaction_orm = TransactionORM()
        self.bucket_name = os.getenv("S3_VADED_BUCKET_NAME", "voice-records")

    async def resolve(self, context: dict, b_id: str) -> ResolvedContext:
        """Resolve a transaction's context dict. Never raises, and never
        returns None.

        The previous version ended in a bare ``except: pass``, so ANY error
        returned None instead of a ResolvedContext. Callers test
        ``if resolved_context and resolved_context.warnings``, so a None also
        threw away the warnings that would have explained the failure: the run
        structured with no context and nothing anywhere said why. Degrade to an
        empty result with a warning instead.
        """
        result = ResolvedContext()
        if not context:
            return result
        if not isinstance(context, dict):
            logger.warning(
                "context is not a dict; ignoring",
                context_type=type(context).__name__,
                severity="medium",
            )
            result.warnings.append(
                f"context has unexpected type {type(context).__name__}"
            )
            return result

        try:
            past_sessions = context.get("past_sessions") or []
            for past_session in past_sessions:
                if isinstance(past_session, dict):
                    session_id = past_session.get("session_id")
                    session_date = past_session.get("date_epoch")
                else:
                    # legacy entries stored as bare session_id strings
                    session_id = past_session
                    session_date = None
                if not session_id:
                    continue
                self._resolve_past_session(session_id, result, session_date, b_id)

            documents = context.get("documents") or []
            for document_id in documents:
                self._resolve_document(document_id, result)
        except Exception as e:
            logger.error(
                "context resolution failed",
                error=f"{type(e).__name__}: {e}",
                exc_info=True,
                severity="high",
            )
            result.warnings.append(f"context resolution failed: {e}")

        # One line per run saying whether context actually made it through --
        # the question "did it pick up the context?" should be answerable from
        # the logs without a debugger.
        logger.info(
            "context resolved",
            requested_documents=len(context.get("documents") or []),
            requested_past_sessions=len(context.get("past_sessions") or []),
            resolved_documents=len(result.documents),
            resolved_past_sessions=len(result.past_sessions),
            warnings=len(result.warnings),
        )
        return result

    
    def _resolve_past_session(
        self, session_id: str, result: ResolvedContext,session_date: any,b_id:str
    ) -> None:
        try:
            #FIXME: this is temparory fix, figure out some solution . just to get the s3_url no need to fetch the entire transaction_data
            past_transaction = self.transaction_orm.get_transaction(txn_id=session_id, b_id=b_id)
            s3_url = past_transaction.get("s3_url")
            transcript = self.transcript_file_service.read_transcript_file(
                s3_url=s3_url, txn_id=session_id
            )

            try:
                transcript = transcript.get("text")
            except Exception as _:
                pass

            result.past_sessions.append(
                PastSessionItem(session_date=session_date, transcript=transcript)
            )
        except Exception as e:
            logger.warning(
                "Failed to resolve past session",
                session_id=session_id,
                error=str(e),
                severity="medium",
            )
            result.warnings.append(
                f"Failed to resolve past session {session_id}: {str(e)}"
            )

    def _resolve_document(self, document_id: str, result: ResolvedContext) -> None:
        try:
            doc = self.document_orm.get_document(document_id)
            if not doc:
                result.warnings.append(f"Document not found: {document_id}")
                return

            document_path = doc.get("document_path")
            if not document_path:
                result.warnings.append(f"Document has no path: {document_id}")
                return

            document_name = doc.get("document_name") or document_id
            document_data, content_type = self._download_s3_bytes(
                self.bucket_name, document_path
            )
            if document_data is None:
                result.warnings.append(f"Failed to download document: {document_id}")
                return
           
            try:
                text = document_data.decode("utf-8")
                try:
                    decoded = base64.b64decode(text, validate=True)
                    text = decoded.decode("utf-8")
                except (base64.binascii.Error, UnicodeDecodeError):
                    pass  
            except UnicodeDecodeError:
                result.warnings.append(f"Document is not valid text: {document_id}")
                return
            
            if not text:
                # The document row exists and the object exists, but it is
                # empty -- which is exactly what document creation writes
                # before the client PUTs the real content. Silently returning
                # here is what made "context is not picked up" invisible.
                logger.warning(
                    "context document is empty; nothing to attach",
                    document_id=document_id,
                    key=document_path,
                    severity="medium",
                )
                result.warnings.append(
                    f"Context document is empty (content not saved to storage "
                    f"yet): {document_id}"
                )
                return

            
            result.documents.append(
                ContextDocumentItem(
                    kind=ContextItemKind.TEXT,
                    document_name=document_name,
                    text=text,
                )
            )
        except Exception as e:
            logger.warning(
                "Failed to resolve document",
                document_id=document_id,
                error=str(e),
                severity="medium",
            )
            result.warnings.append(
                f"Failed to resolve document {document_id}: {str(e)}"
            )

    def _download_s3_bytes(self, bucket: str, key: str):
        try:
            from scribe_core.storage import get_blob_store
            import mimetypes

            body = get_blob_store().get(bucket, key)
            content_type = mimetypes.guess_type(key)[0] or ""
            return body, content_type
        except Exception as e:
            logger.warning(
                "S3 download failed",
                bucket=bucket,
                key=key,
                error=str(e),
                severity="medium",
            )
            return None, ""

