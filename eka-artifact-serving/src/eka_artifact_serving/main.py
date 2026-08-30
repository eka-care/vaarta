"""eka-artifact-serving — the public byte-serving tier.

Deliberately separate from the ekascribe api. That api reserves 3500m CPU and
6.5Gi per pod with Guaranteed QoS and runs two uvicorn workers carrying STT
dispatch; a 200MB installer trickling down a clinic uplink has no business
sharing them. This process holds no database connection, no queue, and no
state -- it streams bytes and resolves a pointer.
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from eka_artifact_serving.routers.artifacts import router as artifacts_router
from eka_artifact_serving.settings import get_settings

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("eka_artifact_serving")


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="eka-artifact-serving", docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(artifacts_router)

    @app.get("/healthz")
    def healthz():
        # Liveness only -- deliberately does NOT touch the object store. A
        # store blip should surface as 5xx on the routes that need it, not as
        # a restart loop that takes the whole tier down with it.
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz():
        # Readiness DOES check config, because a pod with no bucket or no write
        # key can never serve a correct response and should not take traffic.
        problems = []
        if not s.s3_bucket:
            problems.append("S3_BUCKET is unset")
        if not s.write_keys:
            problems.append("ARTIFACTS_KEY is unset")
        if problems:
            return JSONResponse({"status": "not-ready", "problems": problems}, status_code=503)
        return {"status": "ok", "bucket": s.s3_bucket, "prefix": s.prefix}

    log.info(
        "eka-artifact-serving configured: bucket=%s prefix=%s endpoint=%s keys=%d",
        s.s3_bucket or "(unset)", s.prefix, s.s3_endpoint_url or "(aws)", len(s.write_keys),
    )
    return app


app = create_app()
