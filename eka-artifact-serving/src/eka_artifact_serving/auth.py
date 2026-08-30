"""Bearer-key check for the write path.

Reads are open: electron-updater carries no session, so the feed and the
installers have to be fetchable without one. Writes are not.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request

from eka_artifact_serving.settings import get_settings


def require_write_key(request: Request) -> None:
    s = get_settings()
    if not s.write_keys:
        # Failing closed matters more than being available: a service that
        # accepts unauthenticated writes because a Secret did not mount is
        # worse than one that refuses every push.
        raise HTTPException(status_code=503, detail="no write key configured")

    presented = request.headers.get("authorization", "")
    presented = presented[7:].strip() if presented[:7].lower() == "bearer " else ""

    # compare_digest against every configured key, and never short-circuit --
    # `==` leaks the key one byte at a time to anyone who can time the response.
    ok = False
    for key in s.write_keys:
        if hmac.compare_digest(presented, key):
            ok = True
    if not ok:
        raise HTTPException(status_code=401, detail="bad or missing write key")
