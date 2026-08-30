"""Route-level smoke test with the object store stubbed in memory.

No S3, no network, no cluster:

    pip install . httpx && python tests/smoke.py

Covers auth, path validation, the publish gate, relative-path resolution
through a channel, byte ranges, the published-version freeze, and rollback.
"""
import hashlib, io, json, os, sys
os.environ.update(S3_BUCKET="test-bucket", ARTIFACTS_KEY="secret-key", ARTIFACTS_PREFIX="artifacts")

from eka_artifact_serving import store

OBJ = {}  # key -> (bytes, content_type)

class Body(io.BytesIO):
    def iter_chunks(self, chunk_size=1024): 
        while (c := self.read(chunk_size)): yield c

def _get(key, byte_range=None):
    if key not in OBJ: return None
    data = OBJ[key][0]
    if byte_range:
        s, e = byte_range.replace("bytes=", "").split("-")
        s = int(s); e = int(e) if e else len(data) - 1
        if s >= len(data): return None
        part = data[s:e+1]
        return {"Body": Body(part), "ContentLength": len(part),
                "ContentRange": f"bytes {s}-{s+len(part)-1}/{len(data)}", "ETag": '"x"'}
    return {"Body": Body(data), "ContentLength": len(data), "ETag": '"x"'}

store.get = _get
store.get_bytes = lambda k: OBJ[k][0] if k in OBJ else None
store.put_bytes = lambda k, b, ct: OBJ.__setitem__(k, (b, ct))
store.put_stream = lambda k, f, ct: OBJ.__setitem__(k, (f.read(), ct))
store.list_keys = lambda p: [k for k in OBJ if k.startswith(p)]
store.list_prefixes = lambda p: sorted({k[len(p):].split("/")[0] for k in OBJ if k.startswith(p)})

from fastapi.testclient import TestClient
from eka_artifact_serving.main import create_app
c = TestClient(create_app())

fails = []
def check(label, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + label + ("" if cond else f"  <- {extra}"))
    if not cond: fails.append(label)

AUTH = {"Authorization": "Bearer secret-key"}
EXE = b"MZ" + b"\x00" * 5000

print("\n[auth]")
check("no key -> 401", c.put("/artifacts/builds/1.0.3/x.exe", content=b"a").status_code == 401)
check("wrong key -> 401", c.put("/artifacts/builds/1.0.3/x.exe", content=b"a",
      headers={"Authorization": "Bearer nope"}).status_code == 401)

print("\n[validation]")
check("path traversal version -> 400", c.get("/artifacts/builds/..%2F..%2Fetc/x").status_code in (400, 404))
check("bad filename -> 400", c.put("/artifacts/builds/1.0.3/..%2Fevil", content=b"a", headers=AUTH).status_code in (400, 404))
check("bad channel -> 400", c.get("/artifacts/channels/BAD_CHAN").status_code == 400)

print("\n[upload]")
r = c.put("/artifacts/builds/1.0.3/Vaarta-Setup-1.0.3.exe", content=EXE, headers=AUTH)
check("PUT exe -> 200", r.status_code == 200, r.text)
check("size reported", r.json().get("size") == len(EXE), r.text)
check("empty body -> 400", c.put("/artifacts/builds/1.0.3/e.exe", content=b"", headers=AUTH).status_code == 400)

print("\n[publish gate]")
r = c.post("/artifacts/channels/stable", json={"version": "1.0.3"}, headers=AUTH)
check("no manifest -> 400", r.status_code == 400, r.text)

sha = hashlib.sha512(EXE).hexdigest()
bad = f"version: 1.0.3\nfiles:\n  - url: Vaarta-Setup-1.0.3.exe\n    sha512: {sha}\n  - url: MISSING.exe\n    sha512: x\npath: Vaarta-Setup-1.0.3.exe\n"
c.put("/artifacts/builds/1.0.3/latest.yml", content=bad.encode(), headers=AUTH)
r = c.post("/artifacts/channels/stable", json={"version": "1.0.3"}, headers=AUTH)
check("incomplete -> 400", r.status_code == 400, r.text)
check("names the missing file", "MISSING.exe" in r.text, r.text)

good = f"version: 1.0.3\nfiles:\n  - url: Vaarta-Setup-1.0.3.exe\n    sha512: {sha}\n    size: {len(EXE)}\npath: Vaarta-Setup-1.0.3.exe\nsha512: {sha}\n"
c.put("/artifacts/builds/1.0.3/latest.yml", content=good.encode(), headers=AUTH)
r = c.post("/artifacts/channels/stable", json={"version": "1.0.3"}, headers=AUTH)
check("complete -> published", r.status_code == 200 and r.json()["version"] == "1.0.3", r.text)

print("\n[feed]")
r = c.get("/artifacts/channels/stable/latest.yml")
check("feed 200", r.status_code == 200, r.text)
check("feed no-cache", "no-cache" in r.headers.get("cache-control", ""), r.headers.get("cache-control"))
check("feed content", "version: 1.0.3" in r.text)
r = c.get("/artifacts/channels/stable/Vaarta-Setup-1.0.3.exe")
check("relative path resolves through channel", r.status_code == 200 and r.content == EXE, r.status_code)
check("Accept-Ranges present", r.headers.get("accept-ranges") == "bytes")

print("\n[range]")
r = c.get("/artifacts/builds/1.0.3/Vaarta-Setup-1.0.3.exe", headers={"Range": "bytes=0-1023"})
check("206", r.status_code == 206, r.status_code)
check("1024 bytes", len(r.content) == 1024, len(r.content))
check("Content-Range", r.headers.get("content-range") == f"bytes 0-1023/{len(EXE)}", r.headers.get("content-range"))
check("immutable cache on builds/", "immutable" in r.headers.get("cache-control", ""))

print("\n[frozen once published]")
r = c.put("/artifacts/builds/1.0.3/Vaarta-Setup-1.0.3.exe", content=b"tampered", headers=AUTH)
check("published version -> 409", r.status_code == 409, r.text)
r = c.put("/artifacts/builds/1.0.4/Vaarta-Setup-1.0.4.exe", content=EXE, headers=AUTH)
check("unpublished version still writable", r.status_code == 200, r.text)

print("\n[rollback]")
c.put("/artifacts/builds/1.0.4/latest.yml", content=f"version: 1.0.4\nfiles:\n  - url: Vaarta-Setup-1.0.4.exe\npath: Vaarta-Setup-1.0.4.exe\n".encode(), headers=AUTH)
c.post("/artifacts/channels/stable", json={"version": "1.0.4"}, headers=AUTH)
check("feed now 1.0.4", "version: 1.0.4" in c.get("/artifacts/channels/stable/latest.yml").text)
c.post("/artifacts/channels/stable", json={"version": "1.0.3"}, headers=AUTH)
check("rolled back to 1.0.3", "version: 1.0.3" in c.get("/artifacts/channels/stable/latest.yml").text)
check("1.0.4 still downloadable", c.get("/artifacts/builds/1.0.4/Vaarta-Setup-1.0.4.exe").status_code == 200)

print("\n[listing]")
check("lists both versions", set(c.get("/artifacts/builds").json()["versions"]) == {"1.0.3", "1.0.4"}, c.get("/artifacts/builds").json())

print("\n[misc]")
check("healthz", c.get("/healthz").status_code == 200)
check("readyz", c.get("/readyz").status_code == 200, c.get("/readyz").text)
check("unknown file 404", c.get("/artifacts/builds/1.0.3/nope.exe").status_code == 404)
check("HEAD works", c.head("/artifacts/builds/1.0.3/Vaarta-Setup-1.0.3.exe").status_code == 200)

print("\n[stable download alias]")
c.post("/artifacts/channels/stable", json={"version": "1.0.3"}, headers=AUTH)
mac = "version: 1.0.3\nfiles:\n  - url: Vaarta-1.0.3.zip\n    sha512: z\n  - url: Vaarta-1.0.3.dmg\n    sha512: d\npath: Vaarta-1.0.3.zip\n"
OBJ["artifacts/builds/1.0.3/latest-mac.yml"] = (mac.encode(), "text/yaml")
OBJ["artifacts/builds/1.0.3/Vaarta-1.0.3.dmg"] = (b"DMG-BYTES", "application/octet-stream")
r = c.get("/artifacts/channels/stable/download/win", follow_redirects=False)
check("win -> 302", r.status_code == 302, r.status_code)
check("win -> versioned exe", r.headers.get("location") == "/artifacts/builds/1.0.3/Vaarta-Setup-1.0.3.exe", r.headers.get("location"))
check("alias not cached", "no-store" in r.headers.get("cache-control", ""), r.headers.get("cache-control"))
r = c.get("/artifacts/channels/stable/download/mac", follow_redirects=False)
check("mac -> dmg not zip", r.headers.get("location") == "/artifacts/builds/1.0.3/Vaarta-1.0.3.dmg", r.headers.get("location"))
r = c.get("/artifacts/channels/stable/download/mac-zip", follow_redirects=False)
check("mac-zip -> zip", r.headers.get("location") == "/artifacts/builds/1.0.3/Vaarta-1.0.3.zip", r.headers.get("location"))
check("bad platform -> 404", c.get("/artifacts/channels/stable/download/atari").status_code == 404)
r = c.get("/artifacts/channels/stable/download/win")
check("follows through to bytes", r.status_code == 200 and r.content == EXE, r.status_code)

print(f"\n{'ALL PASS' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
