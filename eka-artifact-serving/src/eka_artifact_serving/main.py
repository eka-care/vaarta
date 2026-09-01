"""eka-artifact-serving — the public byte-serving tier.

Deliberately separate from the ekascribe api. That api reserves 3500m CPU and
6.5Gi per pod with Guaranteed QoS and runs two uvicorn workers carrying STT
dispatch; a 200MB installer trickling down a clinic uplink has no business
sharing them. This process holds no database connection, no queue, and no
state -- it streams bytes and resolves a pointer.
"""

from __future__ import annotations

import contextlib
import logging
import os

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from eka_artifact_serving.routers.artifacts import router as artifacts_router
from eka_artifact_serving.routers.models import new_client, router as models_router
from eka_artifact_serving.settings import get_settings

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("eka_artifact_serving")


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI):
    # The proxy's connection pool lives exactly as long as the app does. Built
    # here rather than lazily so it binds to the serving loop, and closed on
    # the way out so shutdown does not strand upstream connections.
    app.state.model_client = new_client()
    try:
        yield
    finally:
        await app.state.model_client.aclose()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="eka-artifact-serving", docs_url=None, redoc_url=None, openapi_url=None,
        lifespan=_lifespan,
    )
    app.include_router(artifacts_router)
    app.include_router(models_router)

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
        # The model proxy is reported but never gates readiness. Serving
        # releases is this tier's job; a missing model key should not pull the
        # update feed out of rotation for every desktop client.
        return {
            "status": "ok",
            "bucket": s.s3_bucket,
            "prefix": s.prefix,
            "model_proxy": "ready" if (s.model_proxy_keys and s.model_base_url) else "disabled",
        }

    log.info(
        "eka-artifact-serving configured: bucket=%s prefix=%s endpoint=%s keys=%d",
        s.s3_bucket or "(unset)", s.prefix, s.s3_endpoint_url or "(aws)", len(s.write_keys),
    )
    log.info(
        "model proxy: upstream=%s keys=%d upstream_auth=%s allowed=%s",
        s.model_base_url or "(unset)", len(s.model_proxy_keys),
        "yes" if s.model_upstream_token else "no",
        ",".join(s.model_allowed_models) or "(any)",
    )
    return app


app = create_app()
