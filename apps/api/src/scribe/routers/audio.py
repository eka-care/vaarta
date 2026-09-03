"""
Audio Upload Protocol Routes

FastAPI endpoints for audio file uploads according to
MedScribeAlliance Protocol Specification v0.1

Endpoints:
- POST /sessions/{session_id}/audio/{file_name} - Upload audio (chunked/single)
"""

from fastapi import (
    APIRouter,
    Request,
    Path,
    Header,
    status,
)
from fastapi.responses import JSONResponse
from typing import Optional

import orjson

from scribe.core.custom_logger import get_logger
from scribe.core.utils import parse_additional_data

from scribe.core.http import RequestHandler, ResponseFormatter
from scribe.schemas import ErrorResponse, UploadType
from scribe.services.adaptors import AudioAdaptor
from scribe.services.transaction_service import TransactionService

logger = get_logger(__name__)

audio_router = APIRouter()

transaction_service = TransactionService()
audio_adaptor = AudioAdaptor()


@audio_router.post(
    "/sessions/{session_id}/audio/{file_name}",
    responses={
        200: {"description": "Audio uploaded successfully"},
        400: {"model": ErrorResponse, "description": "Invalid request"},
        404: {"model": ErrorResponse, "description": "Session not found"},
        413: {"model": ErrorResponse, "description": "File too large"},
    },
    tags=["audio"],
    summary="Upload Raw Audio",
    description="Upload raw audio binary data with filename in path"
)
async def upload_audio(
    request: Request,
    session_id: str = Path(...),
    file_name: str = Path(..., description="Audio filename with extension (e.g., audio_0.webm, audio_1.mp3)"),
    content_type: Optional[str] = Header(None, alias="Content-Type"),
):
    """
    Upload raw audio data to a session.
    
    Endpoint: POST /v1/sessions/{session_id}/audio/{file_name}
    
    Request body: Raw audio binary data
    Content-Type header: audio/webm, audio/mp3, etc.
    
    Supports:
    - Chunked uploads: Multiple files with sequence numbers (audio_0.webm, audio_1.webm, ...)
    - Single uploads: One complete file
    
    File naming for chunked uploads:
    - Format: <base>_<number>.<ext>
    - Example: audio_0.webm, audio_1.webm, audio_2.webm
    """
    b_id = ""
    try:
        headers = RequestHandler.extract_headers(request, session_id)
        
        b_id = headers.get("token_data", {}).get("b-id", "")
        
        session_data = transaction_service.get_transaction(
            session_id,
            b_id,
        )
        
        if session_data.get("additional_data", {}):
            session_data["additional_data"] = parse_additional_data(
                session_data["additional_data"]
            )

        # if user have already ended(committed) the session, then he can't upload any more audio.
        # if session processing have been already completed, then he can't upload any more audio.
        if session_data.get("user_status") == "commit":
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": {
                        "code": "session_ended",
                        "message": "Session has ended, cannot upload audio",
                    }
                }
            )

        if session_data.get("processing_status") in ["success", "failure"]:
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": {
                        "code": "session_completed",
                        "message": "Session processing completed, cannot upload audio",
                    }
                }
            )
        
        # Read raw binary data from request body
        content = await request.body()
        
        # Use filename from path parameter
        filename = file_name
        
        if not content_type or not content_type.lower().strip().startswith("audio/"):
            extension = filename.split('.')[-1].lower()
            content_type_map = {
                'webm': 'audio/webm;codecs=opus',
                'mp3': 'audio/mp3',
                'wav': 'audio/wav',
                'ogg': 'audio/ogg',
                'm4a': 'audio/m4a',
                'mp4': 'audio/mp4',
            }
            file_content_type = content_type_map.get(extension, 'audio/webm')
        else:
            file_content_type = content_type
        
        logger.info(
            "Uploading raw audio data",
            session_id=session_id,
            b_id=b_id,
            audio_file=filename,
            size_bytes=len(content),
            content_type=file_content_type,
        )
        
        if not audio_adaptor.validate_audio_format(file_content_type):
            supported = audio_adaptor.get_supported_formats()
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={
                    "error": {
                        "code": "invalid_audio_format",
                        "message": f"Audio format '{file_content_type}' is not supported",
                        "details": {
                            "provided_format": file_content_type,
                            "supported_formats": supported,
                        }
                    }
                }
            )
        
        # Get upload type from protocol metadata
        protocol_meta = session_data.get("additional_data", {}).get("_protocol", {})
        upload_type = UploadType(protocol_meta.get("upload_type", "chunked"))
        
        # upload audio files to s3
        if upload_type != UploadType.SINGLE:
            result = await audio_adaptor.upload_audio_file(
                session_data=session_data,
                filename=filename,
                content=content,
                content_type=file_content_type,
                upload_type=upload_type,
            )
            
            # Pipeline: transcribe each chunk as it lands.
            try:
                from scribe.pipeline.dispatch import dispatch
                input_langs = session_data.get("input_language") or []
                dispatch(
                    "transcribe_chunk",
                    {
                        "txn_id": session_id,
                        "b_id": b_id,
                        "s3_url": session_data.get("s3_url", ""),
                        "filename": result["filename"],
                        "language": input_langs[0]
                        if isinstance(input_langs, list) and input_langs
                        else (input_langs or None),
                    },
                )
            except Exception as qe:
                logger.error(
                    "Failed to enqueue transcribe_chunk (it will run at commit)",
                    session_id=session_id,
                    error=str(qe),
                    severity="medium",
                )

            # update transaction with simplified filename (e.g., "0.webm", "1.mp3")
            simple_filename = result["filename"]
            current_files = session_data.get("client_uploaded_files", [])
            
            if simple_filename not in current_files:
                current_files.append(simple_filename)
                audio_adaptor.update_transaction(
                    session_id,
                    b_id,
                    {"client_uploaded_files": current_files}
                )
            
            logger.info(
                "Audio uploaded successfully",
                session_id=session_id,
                b_id=b_id,
                original_file=filename,
                s3_file=simple_filename,
                severity="medium",
            )

        # if it's a single upload, perform inline VAD chunking and upload to vaded bucket.
        if upload_type == UploadType.SINGLE:
            session_data["client_generated_files"] = [file_name]
            result = await audio_adaptor.vad_and_upload_chunks(
                session_data=session_data,
                audio_content=content,
                session_id=session_id,
                b_id=b_id,
            )
            
            # Update transaction with the generated chunks (full S3 paths)
            uploaded_files = result.get("uploaded_files", [])
            update_data = {
                "client_generated_files": uploaded_files,
                "client_uploaded_files": uploaded_files,
            }
            audio_adaptor.update_transaction(
                session_id,
                b_id,
                update_data
            )

        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content={
                "session_id" : session_id, 
                "success": True,
                "original_filename": filename,
            }
        )
        
    except ValueError as e:
        logger.error(
            "Validation error uploading audio",
            session_id=session_id,
            b_id=b_id,
            error=str(e),
            severity="critical",
        )
        return ResponseFormatter.from_exception(e, session_id, b_id)
    
    except Exception as e:
        logger.error(
            "Error uploading audio",
            session_id=session_id,
            b_id=b_id,
            error=str(e),
            exc_info=True,
            severity="critical",
        )
        return ResponseFormatter.from_exception(e, session_id, b_id)
