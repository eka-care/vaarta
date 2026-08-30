"""Object-store access.

Five of these six operations (get / put / head / list / delete) are ones the
ekascribe api already makes against this same store in production, so they are
known good. The exception is the RANGED read: nothing in the api has ever sent
a Range header. electron-updater's differential download depends on it, so if
delta updates ever misbehave, verify ranges against the store before suspecting
anything here.
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from eka_artifact_serving.settings import get_settings

log = logging.getLogger(__name__)

_client = None


def client():
    global _client
    if _client is None:
        s = get_settings()
        cfg = None
        if s.s3_addressing_style:
            cfg = Config(s3={"addressing_style": s.s3_addressing_style})
        _client = boto3.client(
            "s3",
            region_name=s.aws_region,
            endpoint_url=s.s3_endpoint_url,  # None => real AWS
            config=cfg,
        )
    return _client


def _missing(err: ClientError) -> bool:
    code = err.response.get("Error", {}).get("Code", "")
    return code in ("404", "NoSuchKey", "NotFound")


def head(key: str) -> dict[str, Any] | None:
    s = get_settings()
    try:
        return client().head_object(Bucket=s.s3_bucket, Key=key)
    except ClientError as e:
        if _missing(e):
            return None
        raise


def get(key: str, byte_range: str | None = None) -> dict[str, Any] | None:
    """Return the raw boto3 response. Caller owns closing ``Body``."""
    s = get_settings()
    kwargs: dict[str, Any] = {"Bucket": s.s3_bucket, "Key": key}
    if byte_range:
        kwargs["Range"] = byte_range
    try:
        return client().get_object(**kwargs)
    except ClientError as e:
        if _missing(e):
            return None
        # A range beyond the object's length is a client error, not ours.
        if e.response.get("Error", {}).get("Code") == "InvalidRange":
            return None
        raise


def get_bytes(key: str) -> bytes | None:
    obj = get(key)
    if obj is None:
        return None
    body = obj["Body"]
    try:
        return body.read()
    finally:
        body.close()


def stream(body, chunk_bytes: int) -> Iterator[bytes]:
    """Yield an object's bytes without ever holding the whole thing.

    A sync generator on purpose: Starlette runs these in its threadpool, so a
    slow 200MB download occupies a thread rather than blocking the event loop.
    """
    try:
        for chunk in body.iter_chunks(chunk_size=chunk_bytes):
            yield chunk
    finally:
        body.close()


def put_stream(key: str, fileobj, content_type: str) -> None:
    """Upload from a file-like object. boto3 splits this into a multipart
    upload above its own threshold -- the other operation the api has never
    exercised against this store."""
    s = get_settings()
    client().upload_fileobj(
        fileobj, s.s3_bucket, key, ExtraArgs={"ContentType": content_type}
    )


def put_bytes(key: str, body: bytes, content_type: str) -> None:
    s = get_settings()
    client().put_object(Bucket=s.s3_bucket, Key=key, Body=body, ContentType=content_type)


def list_prefixes(prefix: str) -> list[str]:
    """Immediate child 'directories' of ``prefix``, without the trailing slash."""
    s = get_settings()
    out: list[str] = []
    paginator = client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=s.s3_bucket, Prefix=prefix, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            out.append(cp["Prefix"][len(prefix):].rstrip("/"))
    return out


def list_keys(prefix: str) -> list[str]:
    s = get_settings()
    out: list[str] = []
    paginator = client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=s.s3_bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            if not item["Key"].endswith("/"):
                out.append(item["Key"])
    return out
