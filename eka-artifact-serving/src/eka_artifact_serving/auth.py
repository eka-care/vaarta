"""Bearer-key checks.

Two independent keys, on purpose:

  ARTIFACTS_KEY     the write path -- publishing installers.
  MODEL_PROXY_KEY   the model proxy -- spending GPU time upstream.

Artifact reads are open, because electron-updater carries no session and the
feed has to be fetchable without one. Writes are not, and the model proxy
certainly is not: it fronts a LiteLLM instance on the client's network.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

from eka_artifact_serving.settings import get_settings


def _bearer(request: Request) -> str:
    presented = request.headers.get("authorization", "")
    return presented[7:].strip() if presented[:7].lower() == "bearer " else ""


def _check(presented: str, keys: tuple[str, ...]) -> bool:
    # compare_digest against every configured key, and never short-circuit --
    # `==` leaks the key one byte at a time to anyone who can time the response.
    ok = False
    for key in keys:
        if hmac.compare_digest(presented, key):
            ok = True
    return ok


def require_write_key(request: Request) -> None:
    s = get_settings()
    if not s.write_keys:
        # Failing closed matters more than being available: a service that
        # accepts unauthenticated writes because a Secret did not mount is
        # worse than one that refuses every push.
        raise HTTPException(status_code=503, detail="no write key configured")
    if not _check(_bearer(request), s.write_keys):
        raise HTTPException(status_code=401, detail="bad or missing write key")


def require_model_key(request: Request) -> None:
    s = get_settings()
    if not s.model_proxy_keys:
        # Same reasoning as the write path, and more so. An unauthenticated
        # proxy in front of a model is an open inference endpoint on a
        # public .gov.in host -- refusing every request is the safe failure.
        raise HTTPException(status_code=503, detail="no model proxy key configured")
    if not _check(_bearer(request), s.model_proxy_keys):
        raise HTTPException(status_code=401, detail="bad or missing model proxy key")
