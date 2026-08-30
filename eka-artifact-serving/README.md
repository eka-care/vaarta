# eka-artifact-serving

Serves the Vaarta desktop app from the client's internal object store, over the
host the app already uses. Self-contained: its own image, its own Deployment,
its own manifests. It shares nothing with `apps/api` except the names of a few
environment variables.

A separate process from the api on purpose: the api handles app logic, this
handles bytes, and a 200MB installer trickling down a clinic uplink should not
be occupying a uvicorn worker that carries STT dispatch.

It does, however, schedule onto the same **nodes** as `ekascribe-api`: the
Deployment carries a copy of the api's `nodeAffinity` — the same
`kubernetes.io/hostname In [...]` list from `deploy/k8s/10-api-deployment.yaml`.
A copy, deliberately, not a `podAffinity` pointing at the api's pods: this
service depends on nothing the api does, and schedules and serves whether the
api is up or not. The flip side is that it does not track the api's pin — if
that hostname list changes, change it here too.

The cost of sharing those nodes is worth knowing: the api pods reserve 3500m
CPU and 6656Mi each with Guaranteed QoS, so downloads now compete for CPU on
the same box. This tier stays Burstable at 200m/1000m so it yields to the api
under contention.

## Why not nginx

nginx does static files and byte ranges natively, and can be coaxed into
authenticated PUTs with `dav_module`. It cannot do the other three things:

| | nginx |
| --- | --- |
| GET files, byte ranges, 206 | yes |
| Authenticated PUT | `dav_module`, crudely |
| Read/write S3-compatible storage | **no** — SigV4 needs the `njs` module and the `nginx-s3-gateway` signing script, which is read-only |
| Resolve `channels/stable` → `builds/1.0.3` | **no** — needs to read a pointer and rewrite the path |
| Publish gate: parse `latest.yml`, verify every file exists | **no** |

It would only work by dropping S3 and serving off a volume, which is the thing
we are moving away from — and the cluster's storage is single-attach anyway.

## Two URL spaces, one store

```
artifacts/builds/1.0.2/…      immutable, kept forever, permanently addressable
artifacts/builds/1.0.3/…
artifacts/channels/stable.json    {"version": "1.0.3", "published_at": "..."}
```

A build is written once and never rewritten. A channel is a pointer at one of
them. **Publishing is the pointer write and nothing else** — a few dozen bytes,
so there is no window where the feed advertises a version whose installer is
still uploading. Rollback is the same write with an older version in it: no
rebuild, no re-signing, no notarization wait.

Files in a release (flat — see *the flat feed* below):

```
Vaarta-Setup-1.0.3.exe          Vaarta-Setup-1.0.3.exe.blockmap
Vaarta-1.0.3.dmg                Vaarta-1.0.3.dmg.blockmap
Vaarta-1.0.3.zip                Vaarta-1.0.3.zip.blockmap
latest.yml                      latest-mac.yml
```

## Routes

| Method & path | Auth | |
| --- | --- | --- |
| `PUT /artifacts/builds/{version}/{file}` | key | Streams into immutable storage. Idempotent until published, then 409. |
| `POST /artifacts/channels/{channel}` | key | `{"version":"1.0.3"}`. Verifies, then writes the pointer. |
| `GET /artifacts/channels/{channel}/{file}` | open | Resolves the pointer and streams. This is the update feed. |
| `GET /artifacts/channels/{channel}` | open | The pointer itself, as JSON. |
| `GET /artifacts/builds/{version}/{file}` | open | Permanent URL. Immutable caching. |
| `GET /artifacts/builds` | open | Versions present, and which are published. |
| `GET /artifacts/channels/{channel}/download/{platform}` | open | Version-free download link. 302s to the current build. `win` / `mac` / `mac-zip`. |
| `GET /artifacts/builds/{version}` | open | Files in one version. |
| `GET /healthz` `/readyz` | open | Liveness never touches the store; readiness checks config. |

Reads are open because `electron-updater` carries no session. Writes take
`Authorization: Bearer <ARTIFACTS_KEY>`, compared with `hmac.compare_digest`.

## The flat feed

`electron-updater` fetches `latest.yml` from the feed URL, then resolves every
`path:` in it **relative to that directory**. With the feed at
`/artifacts/channels/stable/` and `path: Vaarta-Setup-1.0.3.exe`, it requests
`/artifacts/channels/stable/Vaarta-Setup-1.0.3.exe`.

That is why the channel route serves installers and not just the manifest, and
why a version directory must stay flat — a tidy `windows/` and `mac/` split
inside it 404s every update.

Two related things in `vaarta-desktop/package.json`:

- Set `artifactName` to `"Vaarta-Setup-${version}.${ext}"` (win) and
  `"Vaarta-${version}.${ext}"` (mac). Today it is `"Vaarta.${ext}"`, so every
  release produces identically-named files — two versions cannot coexist, and
  a URL does not denote one specific build. It also drops the space that
  forces `Vaarta%20Setup.exe` into every URL.
- Point `AUTO_UPDATE_FEED_URL` at
  `https://vaarta.bharatai.gov.in/artifacts/channels/stable/`.

## Configuration

S3 variables use the same names as the api, so `ekascribe-config` and
`ekascribe-secrets` mount straight in with no duplication.

| | |
| --- | --- |
| `S3_ENDPOINT_URL` `S3_BUCKET` `AWS_REGION` | from `ekascribe-config` |
| `AWS_ACCESS_KEY_ID` `AWS_SECRET_ACCESS_KEY` | from `ekascribe-secrets` |
| `ARTIFACTS_KEY` | write key. Required — the service returns 503 on writes without it. |
| `ARTIFACTS_KEY_NEXT` | second valid key, for rotation without a flag day. |
| `ARTIFACTS_PREFIX` | key prefix, default `artifacts` |
| `ARTIFACTS_MAX_UPLOAD_BYTES` | default 1 GiB |
| `ARTIFACTS_CHANNEL_TTL` | pointer cache seconds, default 30 |
| `S3_ADDRESSING_STYLE` | unset. Set to `path` only if bucket operations start returning odd 404s. |

## Build and deploy

```bash
docker build -t ekacare/ekascribe:artifact-<tag> eka-artifact-serving/
docker push ekacare/ekascribe:artifact-<tag>

kubectl create secret generic eka-artifact-serving-secrets -n eka-care \
  --from-literal=ARTIFACTS_KEY="$(openssl rand -hex 32)"

kubectl apply -f eka-artifact-serving/deploy/10-deployment.yaml
kubectl apply -f eka-artifact-serving/deploy/11-service.yaml
kubectl apply -f eka-artifact-serving/deploy/12-virtualservice.yaml
```

`12-virtualservice.yaml` **replaces** the `varta-vs` currently defined in
`deploy/k8s/ingress/varta-gateway-full.yaml` — same name, same namespace, with
the `/artifacts/` route added above the catch-all. The Gateway is untouched:
same host, same TCL-owned TLS secret, no new certificate.

The Deployment carries a `hostAliases` entry for the object store. It is not
optional — cluster DNS does not resolve that hostname, which is why
`10-api-deployment.yaml` carries the same entry.

## Release from CI

In `release-pipelines`, keep the existing AWS S3 sync and add one step. Store
`ARTIFACTS_KEY` as an environment-scoped secret there.

```yaml
- name: Publish to vaarta.bharatai.gov.in
  if: ${{ needs.verify-ref.outputs.update_latest == 'true' }}
  env:
    BASE: https://vaarta.bharatai.gov.in
    KEY: ${{ secrets.ARTIFACTS_KEY }}
    VERSION: ${{ needs.verify-ref.outputs.version }}
  run: |
    set -euo pipefail
    for f in dist/*; do
      echo "PUT $(basename "$f")"
      curl -fsS --retry 3 --retry-connrefused -T "$f" \
        -H "Authorization: Bearer $KEY" \
        "$BASE/artifacts/builds/$VERSION/$(basename "$f")"
    done
    curl -fsS -X POST \
      -H "Authorization: Bearer $KEY" \
      -H 'Content-Type: application/json' \
      -d "{\"version\":\"$VERSION\"}" \
      "$BASE/artifacts/channels/stable"
```

`curl -T` streams rather than buffering. The `upload-artifact` patterns already
filter `dist/` to exactly the release files, so the glob is safe.

## Verify

```bash
BASE=https://vaarta.bharatai.gov.in/artifacts

curl -sI  $BASE/channels/stable/latest.yml        # 200, Cache-Control: no-cache
curl -s   $BASE/channels/stable/latest.yml        # the version you just shipped
curl -sI  $BASE/channels/stable/Vaarta-Setup-1.0.3.exe   # 200 — the relative-path trap
curl -sI -r 0-1023 $BASE/builds/1.0.3/Vaarta-Setup-1.0.3.exe   # 206 Partial Content
curl -s   $BASE/builds                            # versions present and published
curl -sI  https://vaarta.bharatai.gov.in/voice/ping   # api, unchanged
curl -sI  https://vaarta.bharatai.gov.in/            # web UI, unchanged
```

Rollback is the one worth rehearsing before you need it:

```bash
curl -fsS -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"version":"1.0.2"}' \
  $BASE/channels/stable
```

## Tests

```bash
pip install . httpx && python tests/smoke.py
```

Stubs the object store in memory — no S3, no network, no cluster. Covers auth,
path validation, the publish gate, relative-path resolution through a channel,
byte ranges, the published-version freeze, and rollback.

## Two things the store has never been asked for

`S3BlobStore` in `packages/core` has been running `get_object`, `put_object`,
`head_object`, `list_objects_v2` and `delete_object` against this store in
production, so those are known good. This service also needs:

- **ranged reads** — `electron-updater`'s delta download. If updates work but
  always transfer the full installer, check this first.
- **multipart upload** — `upload_fileobj` splits above its own threshold. This
  is where S3-compatible stores most often diverge.

Probe both from a pod carrying the same `hostAliases` entry:

```bash
aws configure set default.s3.multipart_threshold 8MB
head -c 100M /dev/urandom > /tmp/big
aws s3 cp /tmp/big s3://$S3_BUCKET/probe/big --endpoint-url $S3_ENDPOINT_URL
aws s3api get-object --bucket $S3_BUCKET --key probe/big \
  --range bytes=0-1023 --endpoint-url $S3_ENDPOINT_URL /tmp/chunk
```

If multipart fails on a checksum, set
`AWS_REQUEST_CHECKSUM_CALCULATION=when_required` — botocore 1.36 began sending
checksums by default and many S3-compatible stores mishandle composite
multipart checksums. The SHA-512s in `latest.yml` are the real integrity check
either way.
