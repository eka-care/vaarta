# Architecture

## The pipeline

```
web app (alliance SDK)
  │ POST /voice/v1/sessions              → session + upload_url (S3-POST-shaped,
  │                                        served by the API's blob router)
  │ POST /voice/v1/blob-upload/{bucket}  → chunk lands in storage
  │        └─ api enqueues transcribe_chunk (early STT per chunk)
  │ PATCH /voice/v1/sessions/{id} (end)  → api enqueues process_session
  ▼
apps/worker (procrastinate, queue "scribe")
  process_session: transcribe missing chunks (echo) → stitch numeric order
    → write template_results/transcripts/{txn}_transcript.json
    → PATCH /voice/api/v2/transaction/{txn} {transcript_status: success}
       (the exact callback contract the old ds-service drove)
  finalize_session: poll documents → PATCH {processing_status: success}
  ▼
apps/api fans out from the PATCH: transcript document, per-template structuring
agents (echo → your LLM), webhooks, AG-UI editing, polling semantics — all the
original code paths, unchanged.
```

Single uploads run in-process Silero VAD (`vad_session` job) — replacing the
old chunker lambda. Streaming (WebSocket/pipecat) exists behind
`FEATURE_STREAMING` and is not wired for on-prem in v1.

## Pluggable layers (scribe_core)

- **storage.py** — `BlobStore`: `LocalFSBlobStore` (files under `STORAGE_ROOT`,
  HMAC-tokenized URLs served by the API: GET/PUT + S3-POST-shaped multipart so
  the frontend's `AwsS3StorageProvider` works unchanged) or `S3BlobStore`
  (`S3_ENDPOINT_URL` ⇒ MinIO/LocalStack). Everything addresses blobs as
  `s3://bucket/key` regardless of backend.
- **db/** — each Dynamo table has a relational `TableSpec` (typed key/query
  columns + `data JSONB`; the old GSIs are btree indexes). A Dynamo-expression
  → SQL parser plus `PgResource`/`PgTable`/`PgClient`/`PgAsyncWrapper` shims
  speak the exact boto3/aioboto3 surfaces the forked code uses, so all five
  legacy access paths run unchanged on either backend (`DB_BACKEND`).
  Schema management: idempotent `ensure_schema()` (CREATE TABLE/ADD COLUMN/
  CREATE INDEX IF NOT EXISTS), applied by `scripts/setup.py`.
- **queue.py** — `TaskQueue`: procrastinate producer (jobs in the same
  Postgres) or SQS. The old `voice2rx` SQS message becomes the
  `process_session` job payload — cloud parity is one env var.
- **auth.py** — `DevAuthMiddleware` reproduces the `jwt-payload` header AWS
  API Gateway used to inject; `Principal` is the typed dependency. The
  discovery doc and blob endpoints are public (HMAC tokens auth the latter).
- **settings.py** — single pydantic-settings module; every selector and
  feature flag is an env var.

## echo (packages/echo)

Vendored at v0.3.6-gamma plus: `SarvamTranscriber`, `OpenAICompatibleLLM`
(any base_url — vLLM/Ollama), `FilePromptProvider` (Langfuse `{{var}}`
semantics, versioned file layouts). Agents/prompts drive all structuring.

## Frontend (apps/web)

Hosts are same-origin relative URLs (src/config/hosts.ts) — the static export
is served by the api itself, so no host is baked into the bundle. hosts.ts also
publishes `globalThis.__SCRIBE_HOSTS__` for the vendored ekascribe-ts-sdk.
The alliance SDK's SharedWorker is self-hosted (`public/msa/`). Non-scribe
features and all trackers are env-gated (src/config/features.ts).

## Modes (scribe/modes)

`APP_MODE` picks a `ModeProfile` (`general` | `medical`): the emit-tool
registry the AG-UI agent gets, the mode's `prompts/*.md` (structuring +
template authoring), `tool_prompts.yaml` (per-tool prose rendered into the
system prompt) and `seed_data.yaml`. `scribe/structuring/` stays
domain-agnostic; the medical mode adds eight clinical table kinds
(`MEDICATION_TABLE`, `VITAL_TABLE`, `LAB_RESULTS`, `LAB_INVESTIGATIONS`,
`PROCEDURES`, `DIAGNOSIS`, `EXAMINATION_FINDINGS`, `PATIENT_MEDICAL_HISTORY`)
as pure validate-and-emit tools — no formulary/catalog lookups. `APP_NAME`
is served to the frontend by `/connect-auth/v1/auth-mode` and used as the
discovery document's `service_name`.
