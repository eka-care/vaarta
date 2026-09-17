"""
Discovery Protocol Routes

FastAPI endpoints for service discovery according to
MedScribeAlliance Protocol Specification v0.1

Endpoints:
- GET /.well-known/medscribealliance - Discovery document
"""

import os
from fastapi import APIRouter, status
from fastapi.responses import JSONResponse

from scribe.core.custom_logger import get_logger

from scribe.core.choices import SUPPORTED_LANGUAGES
from scribe.schemas import (
    DiscoveryResponse,
    ServiceInfo,
    Endpoints,
    AuthenticationConfig,
    OIDCConfig,
    Capabilities,
    ModelConfig,
    ModelFeatures,
    LanguageConfig,
)

logger = get_logger(__name__)

discovery_router = APIRouter()
SUPPORTED_LANGUAGE_CODES = [
    lang["id"] for lang in SUPPORTED_LANGUAGES 
]


@discovery_router.get(
    "/.well-known/medscribealliance",
    response_model=DiscoveryResponse,
    responses={
        200: {"description": "Discovery document"},
    },
    tags=["discovery"],
    summary="Discovery Document",
    description="Returns service capabilities and configuration"
)
async def get_discovery_document():
    """
    Get the MedScribeAlliance protocol discovery document.
    
    This endpoint MUST be publicly accessible without authentication.
    
    Returns:
        Service capabilities, supported features, authentication methods,
        available models, and endpoint URLs.
    """
    try:
        # On-prem: everything derives from settings (plan B4 — no eka hardcodes).
        from scribe_core.settings import get_settings

        s = get_settings()
        base_url = os.getenv("API_BASE_URL") or f"{s.self_url.rstrip('/')}/voice"
        oidc_config = OIDCConfig(
            issuer=os.getenv("OIDC_ISSUER", s.self_url),
            authorization_endpoint=os.getenv("OIDC_AUTHORIZE_URL", f"{s.self_url}/oauth2/authorize"),
            token_endpoint=os.getenv("OIDC_TOKEN_URL", f"{s.self_url}/oauth2/token"),
            scopes_supported=["openid", "profile"],
        )
        
        discovery = DiscoveryResponse(
            protocol="medscribealliance",
            protocol_version="0.1",
            supported_versions=["0.1"],
            
            service=ServiceInfo(
                name=os.getenv("SERVICE_NAME", s.app_name),
                documentation_url=f"{base_url}/docs",
                support_email=os.getenv("SUPPORT_EMAIL", s.discovery_support_email),
            ),
            
            endpoints=Endpoints(
                base_url=f"{base_url}/v1",
                webhooks_url=f"{base_url}/v1/webhooks",
                templates_url=f"{base_url}/api/v1/template",
            ),
            
            authentication=AuthenticationConfig(
                supported_methods=["api_key", "oidc"],
                oidc=oidc_config,
            ),
            
            capabilities=Capabilities(
                audio_formats=[
                    "audio/webm;codecs=opus",
                    "audio/wav",
                    "audio/ogg",
                    "audio/ogg;codecs=opus",
                    "audio/mp4",
                    "audio/m4a",
                    "audio/mp3",
                ],
                max_chunk_duration_seconds=20,
                upload_methods=["chunked", "single"],
                webhook_delivery=True,
                client_sdk_delivery=True,
                storage_providers=["aws"],
            ),
            
            models=[
                ModelConfig(
                    id="lite",
                    display_name="Lite",
                    languages=SUPPORTED_LANGUAGE_CODES,
                    max_session_duration_seconds=600,
                    response_speed="fast",
                    features=ModelFeatures(
                        realtime_transcription=False,
                        speaker_diarization=False,
                        custom_templates=False,
                    ),
                ),
                ModelConfig(
                    id="pro",
                    display_name="Professional",
                    languages=SUPPORTED_LANGUAGE_CODES,
                    max_session_duration_seconds=3600,
                    response_speed="standard",
                    features=ModelFeatures(
                        realtime_transcription=True,
                        speaker_diarization=True,
                        custom_templates=True,
                    ),
                ),
            ],
            
            languages=LanguageConfig(
                supported=SUPPORTED_LANGUAGE_CODES,
                auto_detection=False,  # STT endpoint requires an explicit language
            ),
        )
        
        logger.info("Discovery document requested")
        
        # cache the discovery document for 3 hour to avoid unnecessary requests to the server
        return JSONResponse(
            status_code=status.HTTP_200_OK,
            content=discovery.model_dump(),
            headers={
                "Cache-Control": "max-age=10800", 
            }
        )
        
    except Exception as e:
        logger.error(f"Error generating discovery document: {e}", exc_info=True, severity="medium")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "code": "internal_error",
                    "message": "Failed to generate discovery document",
                }
            }
        )
