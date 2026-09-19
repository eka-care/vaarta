"""Central configuration for the whole stack (decision: one pydantic-settings module).

Every scattered ``os.getenv`` in the forked code migrates here during the port.
All services (api, worker, setup script) import the same ``get_settings()``.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Deployment ---------------------------------------------------------
    env: Literal["local", "dev", "prod"] = "local"
    self_url: str = (
        "http://localhost:8000"  # public base URL of the API (discovery doc, upload URLs)
    )
    # Exported web bundle (apps/web out/) served by the api at /. None = API only
    # (native dev runs `next dev` instead); the Docker image sets /app/web-static.
    web_dist_dir: str | None = None

    # --- Pluggable backends --------------------------------------------------
    storage_backend: Literal["local", "s3"] = "local"
    # Where the pipeline runs:
    #   inprocess = FastAPI in-process background jobs (single container, no worker)
    #   worker    = defer to Postgres/procrastinate; apps/worker consumes
    execution_mode: Literal["worker", "inprocess"] = "inprocess"

    # --- Storage ------------------------------------------------------------
    storage_root: str = "./storage"  # STORAGE_BACKEND=local
    s3_bucket: str | None = None  # STORAGE_BACKEND=s3
    s3_endpoint_url: str | None = None  # real AWS if None; LocalStack/MinIO otherwise
    # Route browser uploads/downloads through the API even on S3/MinIO
    # (browser -> backend -> object store). Required when the bucket is not
    # reachable from users' browsers (internal MinIO, no bucket CORS).
    blob_via_api: bool = False
    aws_region: str = "ap-south-1"

    # --- Product mode / branding -------------------------------------------
    # general: meeting/notes scribe (4 generic section tools, GoI templates)
    # medical: clinical scribe (adds the 8 clinical section tools, clinical
    #          system prompt and templates). Picks scribe/modes/<app_mode>/.
    app_mode: Literal["general", "medical"] = "general"
    # Display name shown by the frontend (title, login page, sidebar, print)
    # and advertised as service_name in the discovery document.
    app_name: str = "Vaarta"

    # --- Database -----------------------------------------------------------
    database_url: str = "postgresql://scribe:scribe@localhost:5432/scribe"

    # --- Auth: ONE mode — real cookie/JWT login everywhere (no AUTH_MODE) --
    # All users of a deployment share one workspace; this id partitions their
    # data. (Reads legacy DEV_B_ID too so existing deployments keep their data.)
    workspace_id: str = Field(
        default="onprem-workspace",
        validation_alias=AliasChoices("WORKSPACE_ID", "DEV_B_ID"),
    )
    auth_issuer: str = "scribe.local"
    auth_jwt_secret: str | None = None  # REQUIRED (HS256 session signing key)
    auth_access_ttl_seconds: int = 900  # access JWT lifetime (15 min)
    auth_refresh_ttl_seconds: int = 2592000  # refresh token + cookie lifetime (30 d)
    auth_cookie_name: str = "scribe_session"
    auth_refresh_cookie_name: str = "scribe_refresh"
    auth_cookie_secure: bool = False  # True behind HTTPS (prod)
    auth_cookie_domain: str | None = None  # e.g. .dev.eka.care to span FE/BE subdomains
    # Self-registration is OFF by default. Exception: while the users table
    # is empty, signup is always allowed so a fresh install can create its
    # first account (the door closes again the moment one user exists).
    auth_allow_signup: bool = False
    # --- External identity providers (OIDC + plain OAuth2) ------------------
    # JSON list of provider objects — see scribe_core/providers.py for the
    # schema. Each provider gets its own root-level URLs:
    #   /{oidc|oauth}/{id}/{login,callback,logout}
    # (/oauth/ serves providers with type "oauth2" — short URL, precise type)
    auth_providers: str | None = None
    auth_default_provider: str | None = None  # id used for "the" login button
    # --- Legacy single-provider OIDC_* config -------------------------------
    # Used only when AUTH_PROVIDERS is unset: mapped onto provider id
    # "default" (callback: /oidc/default/callback).
    oidc_issuer: str | None = None  # e.g. https://idp.gov.in/realms/vaarta
    oidc_discovery_url: str | None = (
        None  # default: {issuer}/.well-known/openid-configuration
    )
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None  # omit for a public client (PKCE only)
    oidc_redirect_url: str | None = None  # must match the IdP client config exactly
    oidc_scopes: str = "openid profile email"
    oidc_claim_uuid: str = "sub"  # claim -> our uuid
    oidc_claim_username: str = "email"  # claim -> username + oid
    oidc_claim_name: str = "name"  # claim -> display name
    oidc_display_name: str = "Single sign-on"  # button label: "Login with <name>"
    oidc_post_logout_redirect: str | None = None
    oidc_verify_ssl: bool = True
    oidc_ca_bundle: str | None = None  # PEM path for a private/gov CA
    oidc_tx_cookie_name: str = "scribe_oidc_tx"
    oidc_tx_ttl_seconds: int = 600  # login round-trip window
    oidc_request_timeout_s: float = 10.0
    upload_url_signing_secret: str = (
        "change-me"  # signs tokenized upload URLs (attachAuth: false path)
    )

    # --- Models: STT (decision #14: Sarvam cloud default, local optional) ---
    echo_default_transcriber_provider: str = "sarvam"
    sarvam_api_key: str | None = None
    deepgram_api_key: str | None = None

    # --- Models: LLM (decision #15: any OpenAI-compatible endpoint) ---------
    # Structuring models offered in the UI (comma-separated ids as the serving
    # stack exposes them). The per-run choice wins; ECHO_DEFAULT_LLM_MODEL
    # remains the fallback when the client sends none.
    structuring_models: str = "sov-105b-h200,qwen3-27b,gemma-31b"
    echo_default_llm_provider: str = "openai_compatible"
    echo_llm_base_url: str = (
        "http://localhost:11434/v1"  # vLLM/Ollama; or api.openai.com/v1
    )
    echo_llm_api_key: str | None = None
    echo_llm_model: str = Field(
        default="qwen3:14b",
        validation_alias=AliasChoices("ECHO_LLM_MODEL", "ECHO_DEFAULT_LLM_MODEL"),
    )

    # --- Logging (file-based, keeps get_logger kwargs signature) ------------
    log_dir: str = "./logs"
    log_level: str = "INFO"
    log_max_bytes: int = 50 * 1024 * 1024
    log_backup_count: int = 5

    # --- Discovery doc ------------------------------------------------------
    discovery_support_email: str = "admin@example.com"

    queue_dsn: str | None = Field(
        default=None, description="Override procrastinate DSN; defaults to database_url"
    )

    @property
    def procrastinate_dsn(self) -> str:
        return self.queue_dsn or self.database_url


def _export_env_file() -> None:
    """Export .env into os.environ (setdefault — real env vars win).

    pydantic-settings reads .env for Settings fields, but the forked voice2rx
    code and echo-sdk read os.getenv() directly (ECHO_DEFAULT_TRANSCRIBER_PROVIDER,
    SARVAM_API_KEY, ANTHROPIC_API_KEY, ...). Without this export, those reads
    silently miss .env in any process that wasn't started by the setup script.
    Last occurrence of a key in the file wins (dotenv convention).
    """
    import os
    from pathlib import Path

    path = Path(os.getenv("ENV_FILE", ".env"))
    if not path.is_file():
        return
    parsed: dict = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                parsed[k.strip()] = v.strip()
    except OSError:
        return
    for k, v in parsed.items():
        os.environ.setdefault(k, v)


@lru_cache
def get_settings() -> Settings:
    _export_env_file()
    return Settings()
