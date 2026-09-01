"""Runtime configuration.

Every S3 variable here is read under the SAME name the ekascribe api uses, so
the existing `ekascribe-config` ConfigMap and `ekascribe-secrets` Secret can be
mounted straight into this pod with no duplication and no drift. Only the
ARTIFACTS_* names are new.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _model_keys() -> tuple[str, ...]:
    # Deliberately NOT ARTIFACTS_KEY. That key is held by CI and lets you
    # overwrite installers; this one lets you spend GPU time on a model behind
    # a government network. Sharing one key would mean a leak of either is a
    # leak of both.
    return tuple(k for k in (os.getenv("MODEL_PROXY_KEY"), os.getenv("MODEL_PROXY_KEY_NEXT")) if k)


def _model_allowed() -> tuple[str, ...]:
    # The upstream is a LiteLLM front end; whatever gets added to it later
    # becomes reachable through this proxy the moment it is added. Pinning the
    # models we actually serve means a new one is a deliberate change here, not
    # an accident. Empty string disables the check.
    #
    # The two models actually live. bharatnet/litellm/config.yaml also lists
    # eka-agent-model, which has been pulled -- it stays out of this list until
    # it is serving again. Keep the two in step when that changes: a model live
    # upstream but missing here answers 403, which reads as a proxy bug rather
    # than the deliberate refusal it is.
    raw = os.getenv(
        "MODEL_PROXY_ALLOWED_MODELS",
        "eka-structuring-model,/model/parrotlet-a",
    )
    return tuple(m.strip() for m in raw.split(",") if m.strip())


def _keys() -> tuple[str, ...]:
    # Two slots on purpose. Rotation with a single key means a window where
    # either CI or the service is wrong; with two, you add the new key, switch
    # CI, then drop the old one -- no flag day.
    return tuple(k for k in (os.getenv("ARTIFACTS_KEY"), os.getenv("ARTIFACTS_KEY_NEXT")) if k)


@dataclass(frozen=True)
class Settings:
    # --- object store (shared with the api) ---
    s3_endpoint_url: str | None = field(default_factory=lambda: os.getenv("S3_ENDPOINT_URL") or None)
    s3_bucket: str = field(default_factory=lambda: os.getenv("S3_BUCKET", ""))
    aws_region: str = field(default_factory=lambda: os.getenv("AWS_REGION", "ap-south-1"))
    # Unset = boto3's default, which is what the api already uses successfully
    # against this store. Set to "path" only if bucket operations start
    # returning odd 404s -- some S3-compatible stores never implemented
    # virtual-host-style addressing.
    s3_addressing_style: str = field(default_factory=lambda: os.getenv("S3_ADDRESSING_STYLE", ""))

    # --- this service ---
    prefix: str = field(default_factory=lambda: os.getenv("ARTIFACTS_PREFIX", "artifacts").strip("/"))
    write_keys: tuple[str, ...] = field(default_factory=_keys)
    # A 200MB installer with headroom. The write path is reachable from outside
    # the cluster, so an unbounded PUT would be a disk-filling primitive.
    max_upload_bytes: int = field(default_factory=lambda: _int("ARTIFACTS_MAX_UPLOAD_BYTES", 1024 * 1024 * 1024))
    # The channel pointer is read on every request that resolves through it.
    # A short TTL keeps that off the hot path without making a publish feel slow.
    channel_ttl_seconds: int = field(default_factory=lambda: _int("ARTIFACTS_CHANNEL_TTL", 30))
    stream_chunk_bytes: int = field(default_factory=lambda: _int("ARTIFACTS_CHUNK_BYTES", 1024 * 1024))

    # --- model proxy -----------------------------------------------------
    # MODEL_API_BASE_URL is read under the same name the api uses, so the
    # existing ekascribe-config ConfigMap already supplies it here.
    model_base_url: str = field(
        default_factory=lambda: (os.getenv("MODEL_API_BASE_URL") or "").rstrip("/")
    )
    model_proxy_keys: tuple[str, ...] = field(default_factory=_model_keys)
    # The upstream LiteLLM virtual key, if it requires one. Named to match what
    # the echo SDK already calls it, so a value set once in ekascribe-secrets
    # serves both the api and this proxy.
    model_upstream_token: str | None = field(
        default_factory=lambda: os.getenv("MODEL_API_AUTH_TOKEN") or None
    )
    # A 5B ASR model transcribing a long consultation is not a fast request.
    # Deliberately ABOVE litellm_settings.request_timeout (900s in
    # bharatnet/litellm/config.yaml): if the two matched, a slow upstream would
    # race, and the caller would sometimes get our opaque 504 instead of
    # LiteLLM's own error saying what actually timed out. Still far under the
    # gateway's 3600s.
    model_timeout_seconds: int = field(default_factory=lambda: _int("MODEL_PROXY_TIMEOUT", 960))
    # parrotlet takes audio as base64 over the chat wire, which inflates it
    # ~33%: half an hour of 16kHz mono is ~58MB raw, ~77MB encoded. The body is
    # streamed rather than buffered, so this is a DoS bound, not a memory one.
    model_max_body_bytes: int = field(
        default_factory=lambda: _int("MODEL_PROXY_MAX_BODY_BYTES", 128 * 1024 * 1024)
    )
    model_allowed_models: tuple[str, ...] = field(default_factory=_model_allowed)
    # How much of the body to scan for the "model" key. Bounded so a 128MB
    # audio payload never has to be parsed in full just to route it.
    model_inspect_bytes: int = field(
        default_factory=lambda: _int("MODEL_PROXY_INSPECT_BYTES", 64 * 1024)
    )

    def builds_key(self, version: str, filename: str) -> str:
        return f"{self.prefix}/builds/{version}/{filename}"

    def builds_prefix(self, version: str = "") -> str:
        base = f"{self.prefix}/builds/"
        return f"{base}{version}/" if version else base

    def channel_key(self, channel: str) -> str:
        return f"{self.prefix}/channels/{channel}.json"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
