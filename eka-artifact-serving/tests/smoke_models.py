"""Route-level smoke test for the model proxy, against a stub LiteLLM.

No cluster, no GPU, no real model:

    pip install . httpx uvicorn && python tests/smoke_models.py

Covers auth, the model allowlist, the admin-path allowlist, body limits,
upstream credential replacement, SSE streaming, and upstream failure mapping.
"""
import json, os, socket, threading, time, sys

def _free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

UP = _free_port()

# Settings are read once and cached, so every env var must be set before the
# app is imported.
os.environ.update(
    S3_BUCKET="test-bucket", ARTIFACTS_KEY="artifact-key", ARTIFACTS_PREFIX="artifacts",
    MODEL_PROXY_KEY="model-key",
    MODEL_API_BASE_URL=f"http://127.0.0.1:{UP}/v1",
    MODEL_API_AUTH_TOKEN="sk-upstream-virtual-key",
    MODEL_PROXY_MAX_BODY_BYTES="1048576",   # 1MB, so the 413 test stays fast
)

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse

# --- stub LiteLLM -----------------------------------------------------------
seen: dict = {}

stub = FastAPI()

@stub.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    seen["auth"] = request.headers.get("authorization")
    seen["headers"] = dict(request.headers)
    if body.get("stream"):
        async def gen():
            import asyncio
            for i in range(3):
                yield f"data: {json.dumps({'choices':[{'delta':{'content':str(i)}}]})}\n\n".encode()
                await asyncio.sleep(0.25)
            yield b"data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")
    return JSONResponse({"id": "x", "model": body.get("model"), "choices": []})

@stub.get("/v1/models")
async def models():
    return {"data": [{"id": "eka-structuring-model"}, {"id": "/model/parrotlet-a"}]}

@stub.post("/v1/key/generate")
async def keygen():                      # must never be reachable through the proxy
    seen["admin_hit"] = True
    return {"key": "sk-should-never-happen"}

threading.Thread(
    target=lambda: uvicorn.run(stub, host="127.0.0.1", port=UP, log_level="error"),
    daemon=True,
).start()

import httpx
for _ in range(100):
    try:
        httpx.get(f"http://127.0.0.1:{UP}/v1/models", timeout=1); break
    except Exception:
        time.sleep(0.1)
else:
    print("stub upstream never came up"); sys.exit(1)

# --- the app under test -----------------------------------------------------
from fastapi.testclient import TestClient
from eka_artifact_serving.main import create_app
# Context-managed so the lifespan runs and every request shares one event
# loop -- the proxy's pooled client belongs to it.
c = TestClient(create_app()); c.__enter__()

fails = []
def check(label, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + label + ("" if cond else f"  <- {extra}"))
    if not cond: fails.append(label)

M = "/artifacts/models"
AUTH = {"Authorization": "Bearer model-key"}
GEMMA = {"model": "eka-structuring-model", "messages": [{"role": "user", "content": "hi"}]}

print("\n[auth]")
check("no key -> 401", c.post(f"{M}/chat/completions", json=GEMMA).status_code == 401)
check("wrong key -> 401", c.post(f"{M}/chat/completions", json=GEMMA,
      headers={"Authorization": "Bearer nope"}).status_code == 401)
check("artifact key is NOT a model key", c.post(f"{M}/chat/completions", json=GEMMA,
      headers={"Authorization": "Bearer artifact-key"}).status_code == 401)
check("model key is NOT a write key", c.put("/artifacts/builds/9.9.9/x.exe", content=b"a",
      headers=AUTH).status_code == 401)

print("\n[allowlisted routes only]")
check("admin /key/generate -> 404", c.post(f"{M}/key/generate", json={}, headers=AUTH).status_code == 404)
check("upstream never saw it", "admin_hit" not in seen)
check("/spend/logs -> 404", c.get(f"{M}/spend/logs", headers=AUTH).status_code == 404)
check("path traversal -> 404", c.post(f"{M}/../builds/x", json={}, headers=AUTH).status_code in (404, 405, 307))

print("\n[model allowlist]")
r = c.post(f"{M}/chat/completions", json=GEMMA, headers=AUTH)
check("gemma -> 200", r.status_code == 200, r.text[:120])
check("parrotlet -> 200", c.post(f"{M}/chat/completions",
      json={"model": "/model/parrotlet-a", "messages": []}, headers=AUTH).status_code == 200)
# eka-agent-model is still in bharatnet/litellm/config.yaml but has been
# pulled from service. It must be refused here rather than forwarded to an
# upstream that can no longer answer for it.
check("retired agent model -> 403", c.post(f"{M}/chat/completions",
      json={"model": "eka-agent-model", "messages": []}, headers=AUTH).status_code == 403)
r = c.post(f"{M}/chat/completions", json={"model": "gpt-4o", "messages": []}, headers=AUTH)
check("unlisted model -> 403", r.status_code == 403, r.text[:120])
check("names the model", "gpt-4o" in r.text)
check("no model -> 400", c.post(f"{M}/chat/completions", json={"messages": []}, headers=AUTH).status_code == 400)
check("non-json -> 400", c.post(f"{M}/chat/completions", content=b"not json", headers=AUTH).status_code == 400)

print("\n[upstream credential]")
check("client key replaced upstream", seen.get("auth") == "Bearer sk-upstream-virtual-key", seen.get("auth"))
check("proxy key never forwarded", "model-key" not in json.dumps(seen.get("headers", {})))

print("\n[body limit]")
big = {"model": "eka-structuring-model", "messages": [{"role": "user", "content": "x" * 2_000_000}]}
check("oversized body -> 413", c.post(f"{M}/chat/completions", json=big, headers=AUTH).status_code == 413)

print("\n[GET /models]")
r = c.get(f"{M}/models", headers=AUTH)
check("200", r.status_code == 200)
check("passes upstream json", "eka-structuring-model" in r.text)

print("\n[SSE streams incrementally]")
# Deliberately NOT through TestClient. It drives the app over an in-process
# ASGI transport, which collects the response before handing it back -- so it
# reports identical timings whether the proxy streams or buffers, and cannot
# prove the thing this check exists to prove. A real uvicorn on a real socket
# can.
APP_PORT = _free_port()
threading.Thread(
    target=lambda: uvicorn.run(create_app(), host="127.0.0.1", port=APP_PORT, log_level="error"),
    daemon=True,
).start()
for _ in range(100):
    try:
        httpx.get(f"http://127.0.0.1:{APP_PORT}/healthz", timeout=1); break
    except Exception:
        time.sleep(0.1)
else:
    print("app never came up"); sys.exit(1)

LIVE = f"http://127.0.0.1:{APP_PORT}{M}"
# The stub sleeps 0.25s between events, so a streaming proxy delivers the first
# well before the last; a buffering one delivers them all at the end.
t0 = time.monotonic(); first = None; chunks = 0
with httpx.stream("POST", f"{LIVE}/chat/completions",
                  json={**GEMMA, "stream": True}, headers=AUTH, timeout=30) as r:
    check("sse 200", r.status_code == 200)
    check("sse content-type", "text/event-stream" in r.headers.get("content-type", ""),
          r.headers.get("content-type"))
    for _line in r.iter_lines():
        if _line.strip():
            chunks += 1
            if first is None: first = time.monotonic() - t0
total = time.monotonic() - t0
check("received all events", chunks >= 4, f"chunks={chunks}")
check("first event well before last", first is not None and first < total - 0.2,
      f"first={first:.2f}s total={total:.2f}s")

print("\n[upstream failure mapping]")
import eka_artifact_serving.settings as st
saved = st._settings
st._settings = None
os.environ["MODEL_API_BASE_URL"] = f"http://127.0.0.1:{_free_port()}/v1"   # nothing listening
import eka_artifact_serving.routers.models as mp
mp._client = None
c2 = TestClient(create_app()); c2.__enter__()
check("unreachable upstream -> 502", c2.post(f"{M}/chat/completions", json=GEMMA,
      headers=AUTH).status_code == 502)
st._settings = saved; mp._client = None

c2.__exit__(None, None, None); c.__exit__(None, None, None)

print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
sys.exit(1 if fails else 0)
