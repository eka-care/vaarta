"""Authenticated pass-through to the LiteLLM front end on the client network.

    /artifacts/models/...  ->  $MODEL_API_BASE_URL/...

`/artifacts/models` stands in for LiteLLM's `/v1`, so an OpenAI-compatible
client only has to set base_url=https://<host>/artifacts/models and present
MODEL_PROXY_KEY. Two models sit behind it, and both are reached the same way,
through chat completions -- `eka-structuring-model` (Gemma) with text, and
`/model/parrotlet-a` (ASR) with base64 audio in an `input_audio` content part.

Routes are enumerated, never `{path:path}`. LiteLLM serves its admin API from
the same origin as its inference API -- /key/generate, /model/new,
/spend/logs, /user/new. A wildcard proxy would let anyone holding the proxy
key mint a LiteLLM virtual key and then address the model directly, bypassing
this service and anything it enforces, permanently. Adding a route here is a
deliberate act; that is the point.
"""

from __future__ import annotations

import json
import logging
import re
import tempfile
import time
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from eka_artifact_serving.auth import require_model_key
from eka_artifact_serving.settings import get_settings

log = logging.getLogger(__name__)

router = APIRouter(prefix="/artifacts/models", dependencies=[Depends(require_model_key)])

# Defined by RFC 7230 as connection-scoped: they describe the hop we are
# terminating, not the message, so forwarding them corrupts the next hop.
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "trailers", "transfer-encoding", "upgrade",
})

# Never forwarded from the client: authorization is ours to replace (the
# caller's proxy key must not reach LiteLLM), host and content-length are
# httpx's to set from the request it actually builds.
_DROP_REQUEST = _HOP_BY_HOP | {"authorization", "host", "content-length"}

def new_client() -> httpx.AsyncClient:
    """One pooled client, created and closed by the app lifespan.

    Pooling matters: a fresh connection per completion is most of the latency
    on a slow internal link. It is owned by the lifespan rather than a module
    global because an AsyncClient binds to the event loop that first used it --
    a process-wide singleton silently breaks anywhere the app is driven by more
    than one loop, and leaks its connections on shutdown.
    """
    s = get_settings()
    return httpx.AsyncClient(
        timeout=httpx.Timeout(s.model_timeout_seconds, connect=10.0),
        follow_redirects=False,
    )


def _http(request: Request) -> httpx.AsyncClient:
    client = getattr(request.app.state, "model_client", None)
    if client is None:
        raise HTTPException(status_code=503, detail="model proxy client not initialised")
    return client


def _upstream(path: str) -> str:
    s = get_settings()
    if not s.model_base_url:
        raise HTTPException(status_code=503, detail="MODEL_API_BASE_URL is unset")
    return f"{s.model_base_url}/{path.lstrip('/')}"


def _forward_headers(request: Request) -> dict[str, str]:
    s = get_settings()
    out = {k: v for k, v in request.headers.items() if k.lower() not in _DROP_REQUEST}
    # The client authenticated to us with MODEL_PROXY_KEY. Upstream gets the
    # LiteLLM virtual key instead, or no credential at all -- never the
    # caller's, which would hand our proxy key to the backend.
    if s.model_upstream_token:
        out["Authorization"] = f"Bearer {s.model_upstream_token}"
    return out


async def _spool_body(request: Request) -> tempfile.SpooledTemporaryFile:
    """Body to a spool, bounded, so it can be inspected and then replayed.

    parrotlet carries audio as base64, so a body is routinely tens of MB. It
    spills to disk past 8MB rather than sitting in the heap of a 512Mi pod --
    the same trade the artifact upload path makes.
    """
    s = get_settings()
    spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > s.model_max_body_bytes:
            spool.close()
            raise HTTPException(status_code=413, detail="request body too large")
        spool.write(chunk)
    spool.seek(0)
    return spool


# Deliberately a scan of the first bytes rather than json.loads of the whole
# body. A parrotlet request is mostly one base64 audio string; parsing 128MB of
# it would materialise the entire payload plus dict overhead in a 512Mi pod,
# and two concurrent requests would end the process. Every OpenAI-compatible
# client -- including echo's own model_api transcriber -- emits "model" as the
# first key, so a bounded prefix is enough to make the allowlist decision.
_MODEL_RE = re.compile(rb'"model"\s*:\s*"((?:[^"\\]|\\.)*)"')


def _check_model(spool: tempfile.SpooledTemporaryFile) -> str:
    """Reject models we do not intend to serve, before spending upstream time.

    Whatever is registered in LiteLLM is reachable through it; without this,
    every model anyone adds later is silently published on a public host.
    """
    s = get_settings()
    head = spool.read(s.model_inspect_bytes)
    spool.seek(0)
    if not head.lstrip()[:1] == b"{":
        raise HTTPException(status_code=400, detail="body must be a json object")
    m = _MODEL_RE.search(head)
    if not m:
        raise HTTPException(
            status_code=400,
            detail=f'body must name a model within its first {s.model_inspect_bytes} bytes',
        )
    try:
        model = json.loads(b'"' + m.group(1) + b'"')
    except ValueError:
        raise HTTPException(status_code=400, detail="body must name a model")
    if not model:
        raise HTTPException(status_code=400, detail="body must name a model")
    if s.model_allowed_models and model not in s.model_allowed_models:
        raise HTTPException(status_code=403, detail=f"model not allowed: {model}")
    return model


async def _replay(spool: tempfile.SpooledTemporaryFile, chunk: int) -> AsyncIterator[bytes]:
    """Feed the spooled body upstream.

    httpx will not accept a plain file object on an AsyncClient -- it treats it
    as a sync stream and refuses to send it -- so the spool is replayed as an
    async iterator instead. Reads are 1MB at a time and land in the page cache
    for anything that never spilled to disk.
    """
    try:
        while True:
            data = spool.read(chunk)
            if not data:
                break
            yield data
    finally:
        spool.close()


async def _relay(request: Request, method: str, path: str, content: Any = None) -> StreamingResponse:
    url = _upstream(path)
    client = _http(request)
    started = time.monotonic()
    req = client.build_request(method, url, headers=_forward_headers(request), content=content)
    try:
        upstream = await client.send(req, stream=True)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="model upstream timed out")
    except httpx.HTTPError as exc:
        # The hostname resolves only through the pod's hostAliases entry, so a
        # connect failure here usually means that entry is missing, not that
        # the model is down. Say so without leaking the internal address.
        log.warning("model upstream unreachable: %s", exc.__class__.__name__)
        raise HTTPException(status_code=502, detail="model upstream unreachable")

    # Never log bodies or headers: these carry clinical audio and text.
    log.info(
        "proxy %s %s -> %s in %.2fs",
        method, path, upstream.status_code, time.monotonic() - started,
    )
    headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP}
    # aiter_raw, not aiter_bytes: raw preserves the upstream's own framing, so
    # `stream: true` completions arrive as SSE events as they are produced
    # rather than being reassembled and delivered in one block at the end.
    return StreamingResponse(
        upstream.aiter_raw(),
        status_code=upstream.status_code,
        headers=headers,
        background=BackgroundTask(upstream.aclose),
    )


@router.post("/chat/completions")
async def chat_completions(request: Request):
    """Both models live here -- Gemma structuring and parrotlet-a ASR."""
    s = get_settings()
    spool = await _spool_body(request)
    _check_model(spool)
    return await _relay(
        request, "POST", "chat/completions", content=_replay(spool, s.stream_chunk_bytes)
    )


@router.get("/models")
async def list_models(request: Request):
    return await _relay(request, "GET", "models")
