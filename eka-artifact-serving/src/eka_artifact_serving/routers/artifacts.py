"""The artifact routes.

Two URL spaces over one store:

  builds/{version}/{file}     immutable. Written once, kept forever, permanently addressable.
  channels/{name}/{file}      a view: resolves through a pointer object to
                              whichever version is currently published.

Publishing is the pointer write and nothing else -- a few dozen bytes -- so
there is no window in which the feed advertises a version whose installer is
still uploading.
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
import time
from datetime import datetime, timezone
from typing import Any

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from eka_artifact_serving import store
from eka_artifact_serving.auth import require_write_key
from eka_artifact_serving.settings import get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/artifacts")

# Anything that reaches an S3 key must be validated first -- these all end up
# concatenated into a key, and ".." or "/" would let a caller address objects
# outside the artifact prefix.
#
# The version pattern allows the pipeline's untagged preprod form as well as
# plain semver: 0.0.0-my-branch-1a2b3c4 (release-pipelines verify-ref).
_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$")
_CHANNEL = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")

_MANIFESTS = ("latest.yml", "latest-mac.yml", "latest-linux.yml")

# Stable download aliases. A human-facing link must not carry a version, or
# every release breaks the download page and every doc that ever linked it.
# Note mac maps to the .dmg, NOT the .zip: latest-mac.yml's `path` is the zip
# because that is what the updater unpacks, but a person installing by hand
# wants the disk image.
_PLATFORM = {
    "win": ("latest.yml", (".exe",)),
    "mac": ("latest-mac.yml", (".dmg",)),
    "mac-zip": ("latest-mac.yml", (".zip",)),
}

_CONTENT_TYPES = {
    ".yml": "text/yaml",
    ".yaml": "text/yaml",
    ".json": "application/json",
}

# latest.yml IS the release pointer as far as a client is concerned. Caching it
# anywhere would mean a published version sitting invisible behind a stale copy.
_NO_STORE = "no-cache, no-store, must-revalidate"
_IMMUTABLE = "public, max-age=31536000, immutable"
_SHORT = "public, max-age=300"


def _content_type(filename: str) -> str:
    for ext, ct in _CONTENT_TYPES.items():
        if filename.lower().endswith(ext):
            return ct
    return "application/octet-stream"


def _check_version(version: str) -> str:
    if not _VERSION.match(version):
        raise HTTPException(status_code=400, detail="bad version")
    return version


def _check_channel(channel: str) -> str:
    if not _CHANNEL.match(channel):
        raise HTTPException(status_code=400, detail="bad channel")
    return channel


def _check_filename(filename: str) -> str:
    if not _FILENAME.match(filename) or ".." in filename:
        raise HTTPException(status_code=400, detail="bad filename")
    return filename


# --- channel pointer ---------------------------------------------------------

_channel_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def _read_channel(channel: str, use_cache: bool = True) -> dict[str, Any] | None:
    s = get_settings()
    now = time.monotonic()
    if use_cache:
        hit = _channel_cache.get(channel)
        if hit and now - hit[0] < s.channel_ttl_seconds:
            return hit[1]

    raw = store.get_bytes(s.channel_key(channel))
    payload = None
    if raw:
        try:
            payload = json.loads(raw)
        except ValueError:
            log.error("channel pointer is not valid json", extra={"channel": channel})
    _channel_cache[channel] = (now, payload)
    return payload


def _published_versions() -> set[str]:
    """Versions any channel currently points at."""
    s = get_settings()
    out: set[str] = set()
    for key in store.list_keys(f"{s.prefix}/channels/"):
        raw = store.get_bytes(key)
        if not raw:
            continue
        try:
            v = json.loads(raw).get("version")
        except ValueError:
            continue
        if v:
            out.add(v)
    return out


# --- reads -------------------------------------------------------------------


def _stream_key(key: str, request: Request, cache_control: str, filename: str):
    s = get_settings()
    byte_range = request.headers.get("range")

    obj = store.get(key, byte_range)
    if obj is None:
        raise HTTPException(status_code=404, detail="not found")

    headers = {
        # electron-updater checks for this before attempting a delta. Without
        # it, every update silently becomes a full download.
        "Accept-Ranges": "bytes",
        "Content-Length": str(obj["ContentLength"]),
        "Cache-Control": cache_control,
    }
    content_range = obj.get("ContentRange")
    if content_range:
        headers["Content-Range"] = content_range
    etag = obj.get("ETag")
    if etag:
        headers["ETag"] = etag

    if request.method == "HEAD":
        obj["Body"].close()
        return StreamingResponse(
            iter(()), status_code=206 if content_range else 200, headers=headers,
            media_type=_content_type(filename),
        )

    return StreamingResponse(
        store.stream(obj["Body"], s.stream_chunk_bytes),
        status_code=206 if content_range else 200,
        headers=headers,
        media_type=_content_type(filename),
    )


@router.get("/builds")
def list_builds():
    s = get_settings()
    versions = store.list_prefixes(s.builds_prefix())
    published = _published_versions()
    return {
        "versions": sorted(versions),
        "published": sorted(published),
    }


@router.get("/builds/{version}")
def list_build_files(version: str):
    s = get_settings()
    _check_version(version)
    prefix = s.builds_prefix(version)
    files = [k[len(prefix):] for k in store.list_keys(prefix)]
    if not files:
        raise HTTPException(status_code=404, detail="no such version")
    return {"version": version, "files": sorted(files)}


@router.api_route("/builds/{version}/{filename}", methods=["GET", "HEAD"])
def get_build_file(version: str, filename: str, request: Request):
    s = get_settings()
    _check_version(version)
    _check_filename(filename)
    # A build URL always denotes one specific set of bytes, so it can be cached
    # forever -- provided artifactName carries the version (see README).
    cache = _NO_STORE if filename in _MANIFESTS else _IMMUTABLE
    return _stream_key(s.builds_key(version, filename), request, cache, filename)


@router.get("/channels/{channel}")
def get_channel(channel: str):
    _check_channel(channel)
    payload = _read_channel(channel)
    if payload is None:
        raise HTTPException(status_code=404, detail="channel not published")
    return JSONResponse(payload, headers={"Cache-Control": _NO_STORE})


@router.api_route("/channels/{channel}/{filename}", methods=["GET", "HEAD"])
def get_channel_file(channel: str, filename: str, request: Request):
    """The auto-update feed.

    electron-updater fetches latest.yml here, then resolves every `path:` in it
    RELATIVE TO THIS DIRECTORY -- so the installers have to be reachable at this
    prefix too, not only under /builds/. That is what this route is for.
    """
    s = get_settings()
    _check_channel(channel)
    _check_filename(filename)

    payload = _read_channel(channel)
    if payload is None:
        raise HTTPException(status_code=404, detail="channel not published")
    version = payload.get("version")
    if not version or not _VERSION.match(version):
        raise HTTPException(status_code=500, detail="channel pointer is malformed")

    cache = _NO_STORE if filename in _MANIFESTS else _SHORT
    return _stream_key(s.builds_key(version, filename), request, cache, filename)


@router.get("/channels/{channel}/download/{platform}")
def download_latest(channel: str, platform: str):
    """Version-free download link: /artifacts/channels/stable/download/win

    Redirects to the immutable build URL, so the browser ends up on a
    versioned, cacheable link with the right filename -- while the link you
    publish never changes.
    """
    s = get_settings()
    _check_channel(channel)
    if platform not in _PLATFORM:
        raise HTTPException(
            status_code=404, detail=f"platform must be one of: {', '.join(_PLATFORM)}"
        )

    payload = _read_channel(channel)
    if payload is None:
        raise HTTPException(status_code=404, detail="channel not published")
    version = payload.get("version", "")
    if not _VERSION.match(version):
        raise HTTPException(status_code=500, detail="channel pointer is malformed")

    manifest, exts = _PLATFORM[platform]
    raw = store.get_bytes(s.builds_key(version, manifest))
    if not raw:
        raise HTTPException(status_code=404, detail=f"{version} has no {manifest}")
    try:
        doc = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        raise HTTPException(status_code=500, detail=f"{manifest} is not valid yaml")

    names = [str((e or {}).get("url", "")) for e in (doc.get("files") or [])]
    if doc.get("path"):
        names.append(str(doc["path"]))
    match = next((n for n in names if n.lower().endswith(exts)), None)
    if not match:
        raise HTTPException(
            status_code=404, detail=f"{version} has no {'/'.join(exts)} in {manifest}"
        )

    return RedirectResponse(
        url=f"/artifacts/builds/{version}/{match}",
        status_code=302,
        # The alias resolves to a different build after every publish, so it
        # must never be cached -- only its target may be.
        headers={"Cache-Control": _NO_STORE},
    )


# --- writes ------------------------------------------------------------------


@router.put("/builds/{version}/{filename}", dependencies=[Depends(require_write_key)])
async def put_build_file(version: str, filename: str, request: Request):
    s = get_settings()
    _check_version(version)
    _check_filename(filename)

    # A version some channel is serving right now must not change underneath
    # the clients downloading it. Retries of an unpublished version are fine --
    # that is what makes the upload step idempotent.
    if version in await run_in_threadpool(_published_versions):
        raise HTTPException(
            status_code=409,
            detail=f"{version} is published; publish a new version instead of rewriting it",
        )

    # Spooled: small files stay in memory, a 200MB installer spills to disk.
    # Either way the whole artifact never sits in the process heap, which is
    # what would OOM the pod under two concurrent uploads.
    spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    total = 0
    try:
        async for chunk in request.stream():
            total += len(chunk)
            if total > s.max_upload_bytes:
                raise HTTPException(status_code=413, detail="upload too large")
            spool.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="empty body")
        spool.seek(0)
        await run_in_threadpool(
            store.put_stream, s.builds_key(version, filename), spool, _content_type(filename)
        )
    finally:
        spool.close()

    log.info("stored %s/%s (%d bytes)", version, filename, total)
    return {"version": version, "filename": filename, "size": total}


@router.post("/channels/{channel}", dependencies=[Depends(require_write_key)])
async def publish(channel: str, request: Request):
    """Point a channel at a version -- the release.

    Verifies first: every file named by that version's manifests must already
    be in the store. A half-finished push then fails here, visibly, in CI --
    rather than reaching a clinician as an update offer that 404s.
    """
    s = get_settings()
    _check_channel(channel)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be json")
    version = str(body.get("version", ""))
    _check_version(version)

    missing, manifests = await run_in_threadpool(_verify_version, version)
    if not manifests:
        raise HTTPException(
            status_code=400,
            detail=f"{version} has no manifest ({' or '.join(_MANIFESTS)}) -- nothing was uploaded",
        )
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"{version} is incomplete, missing: {', '.join(sorted(missing))}",
        )

    payload = {
        "version": version,
        "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "manifests": sorted(manifests),
    }
    await run_in_threadpool(
        store.put_bytes,
        s.channel_key(channel),
        json.dumps(payload).encode(),
        "application/json",
    )
    _channel_cache.pop(channel, None)
    log.info("published %s -> %s", channel, version)
    return payload


def _verify_version(version: str) -> tuple[set[str], set[str]]:
    """(files named but absent, manifests found)."""
    s = get_settings()
    present = {k.rsplit("/", 1)[-1] for k in store.list_keys(s.builds_prefix(version))}

    manifests: set[str] = set()
    named: set[str] = set()
    for name in _MANIFESTS:
        if name not in present:
            continue
        raw = store.get_bytes(s.builds_key(version, name))
        if not raw:
            continue
        manifests.add(name)
        try:
            doc = yaml.safe_load(raw) or {}
        except yaml.YAMLError:
            raise HTTPException(status_code=400, detail=f"{name} is not valid yaml")

        # electron-builder writes both a `files:` list and a legacy top-level
        # `path:`. Check every name either of them mentions.
        for entry in doc.get("files") or []:
            url = (entry or {}).get("url")
            if url:
                named.add(str(url))
        if doc.get("path"):
            named.add(str(doc["path"]))

    return named - present, manifests
