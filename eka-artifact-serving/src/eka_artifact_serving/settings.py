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
