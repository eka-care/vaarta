# ekascribe on Kubernetes

Flat manifests for the api service (which also serves the static web UI) in
namespace `eka-care`. Plain `kubectl` — no kustomize, no Helm.

**What this does not deploy:** the pipeline worker and any ingress. Access is
via `kubectl port-forward`. Postgres *is* included — a single-replica
StatefulSet on a PVC. Point `DATABASE_URL` elsewhere if you would rather use
RDS or another managed instance, and skip `04-`/`05-`.

| File | What |
|---|---|
| `01-configmap.yaml` | Non-secret config (mirrors `.env.example`) |
| `02-secret.yaml.example` | DB password, API keys — template, not applied |
| `03-regcred.yaml.example` | Docker Hub pull credential — template, not applied |
| `04-postgres-service.yaml` | Headless Service `ekascribe-postgres` |
| `05-postgres-statefulset.yaml` | Postgres 16, 1 replica, 20Gi PVC |
| `06-migrate-job.yaml` | Schema + seed data, run once before the workloads |
| `10-` / `11-` | api Deployment + ClusterIP Service (API + web UI on :8000) |

One database serves everything: the app tables, the procrastinate queue
(`QUEUE_BACKEND=postgres`), session state (`STATE_BACKEND=postgres`), and the
formulary catalog (`ECHO_PG_*`).

Numeric prefixes exist so `kubectl apply -f .` applies in dependency order.

## Deploy

Namespace `eka-care` is a precondition, not something these manifests create —
there is no `00-namespace.yaml`, because creating namespaces is a cluster-scoped
right the deploying identity usually does not hold. Confirm it exists first:

```bash
kubectl get ns eka-care
```

If it is missing, someone with cluster-scoped rights has to create it before
anything below will apply.

Push images next — `./deploy/push.sh <tag>` builds and pushes the api image
(it also carries the web bundle). On an existing cluster the same command
applies `01-configmap.yaml` and rolls the deployment to the new tag; pass
`--push-only` to push without touching the cluster.

Create the two credentials directly against the cluster so nothing real lands
in the repo. Use a Docker Hub **access token**, not your password:

```bash
kubectl create secret docker-registry ekascribe-regcred -n eka-care --docker-server=https://index.docker.io/v1/ --docker-username=YOUR_USER --docker-password=YOUR_ACCESS_TOKEN
```

Generate the database password once and use it three times — `POSTGRES_PASSWORD`
is what initdb sets on the `scribe` role, and the other two are how the app
reaches it. A mismatch surfaces as three unrelated-looking failures:

```bash
PGPASS="$(openssl rand -hex 24)"; kubectl create secret generic ekascribe-secrets -n eka-care --from-literal=POSTGRES_PASSWORD="$PGPASS" --from-literal=DATABASE_URL="postgresql://scribe:$PGPASS@ekascribe-postgres.eka-care.svc.cluster.local:5432/scribe" --from-literal=ECHO_PG_PASSWORD="$PGPASS" --from-literal=ANTHROPIC_API_KEY='...' --from-literal=SARVAM_API_KEY='...' --from-literal=UPLOAD_URL_SIGNING_SECRET="$(openssl rand -hex 32)"
```

Then apply everything else — no manual edits needed, `ECHO_PG_HOST` and
`DATABASE_URL` already point at the in-cluster Service:

```bash
kubectl apply -f deploy/k8s/
```

Check what admission will do before you commit to it. This runs the real
webhooks (including any OPA/Gatekeeper policy) and persists nothing:

```bash
kubectl apply -f deploy/k8s/ --dry-run=server
```

One gap worth knowing: `PSP*`-style Gatekeeper constraints match `Pod`, and a
dry-run of a Deployment or StatefulSet never produces a Pod — so a clean dry-run
here does **not** prove the pods will be admitted. If pods never appear and the
controller is silent, check `kubectl -n eka-care get events` for webhook denials.

The two secret templates end in `.yaml.example`, not `.yaml`, specifically so
this directory apply skips them — otherwise it would overwrite the credentials
you just created with `REPLACE_ME` placeholders. If you would rather fill in
the files than use `kubectl create secret`, copy one to a `.yaml` name, edit it,
and apply it explicitly. The root `.gitignore` ignores
`deploy/k8s/*secret*.yaml` and `deploy/k8s/*regcred*.yaml` so those filled-in
copies stay untracked; the `.yaml.example` templates do not match those
patterns and remain in git.

Wait for the migration to finish before trusting the api:

```bash
kubectl -n eka-care wait --for=condition=complete job/ekascribe-migrate --timeout=300s
```

## Access

No ingress — everything is ClusterIP:

```bash
kubectl -n eka-care port-forward svc/ekascribe-api 8000:8000
```

`curl localhost:8000/healthz` should return `{"status":"ok","env":"prod"}`.

## Pinning image tags

Manifests default to `api-latest` with `imagePullPolicy: Always`
so a fresh `apply` picks up whatever was pushed last. For anything you care
about, pin the immutable sha tag — `deploy/push.sh <tag>` does exactly this
for you, and `--push-only` prints the command instead:

```bash
kubectl -n eka-care set image deploy/ekascribe-api api=ekacare/ekascribe:api-1a2b3c4
```

## S3 permissions the migrate Job needs

Verified against the real bucket, not assumed. `setup.py`'s storage probe does
a put → get → exists → **delete** round trip, and it exits 1 if any step fails.
`s3:DeleteObject` is therefore required, not optional — a role with only
read/write passes three steps and then fails the Job:

```
[ok]   postgres reachable
[FAIL] storage: An error occurred (AccessDenied) when calling the DeleteObject operation
[ok]   app schema (tables + indexes)
[ok]   procrastinate schema applied
[ok]   seeded 0 sections, 5 templates
Completed with issues: storage
```

Note what that output means: the schema and seeds **succeeded**. The app would
run fine. But the Job still exits 1, retries to `backoffLimit`, ends up
`Failed`, and `kubectl wait --for=condition=complete` times out — so a working
deployment looks broken.

The pod identity (IRSA, instance role, or static keys) needs at least:

```
s3:PutObject, s3:GetObject, s3:DeleteObject   on   arn:aws:s3:::voice-records/*
s3:ListBucket                                 on   arn:aws:s3:::voice-records
```

The probe writes to `_setup/probe.txt` in a **hardcoded** bucket named
`voice-records` — it ignores `S3_BUCKET`. If your bucket is named something
else, grant the probe permissions on `voice-records` too, or run the Job once
with `STORAGE_BACKEND=local` (schema and seeds do not touch S3) and rely on the
api pod to surface real storage problems.

## Two things that will bite you

**1. `SELF_URL` is in-cluster, `API_BASE_URL` is browser-facing.**
`SELF_URL` points at `ekascribe-api.eka-care.svc.cluster.local:8000` because the
pipeline PATCHes its own API over it
(`apps/api/src/voice2rx/background/pipeline.py`). Repointing it at a public
hostname sends in-cluster traffic out and back in, and breaks entirely while
access is port-forward only. When the API gets a real hostname, change
`API_BASE_URL` instead — the discovery doc and session helpers check it first
and only fall back to `SELF_URL`.

**2. Two api replicas make serving HA, not the pipeline.**
`EXECUTION_MODE=inprocess` runs the scribe pipeline as background jobs inside
each API process (`background/runner.py`) — an in-memory thread pool, fire and
forget. Each replica therefore runs its *own independent* runner. A job
scheduled on one pod is invisible to the other, and losing that pod drops
whatever it had in flight, with no retry.

So what the second replica buys is HTTP availability: uploads and job-status
reads survive one pod dying, because those go through Postgres rather than
process memory. What it does not buy is a durable or distributed pipeline. For
at-least-once retries across restarts, switch `EXECUTION_MODE` to `worker` and
add a worker Deployment running `deploy/Dockerfile.worker` — `QUEUE_BACKEND`
is already `postgres`, so procrastinate is ready for it.

`UVICORN_WORKERS` must stay at **1** regardless. That constraint is about
processes inside a single pod (a job must stay visible to the process that
scheduled it), and is unrelated to replica count.

The api Deployment sets soft pod anti-affinity so its replicas spread across
nodes. It is `preferred`, not `required` — under node pressure a pod will
co-locate rather than sit Pending, which quietly costs you the HA. Worth
checking with `kubectl -n eka-care get pods -o wide` after any capacity change.

## What this Postgres does not give you

`05-postgres-statefulset.yaml` is one plain `postgres:16-alpine` pod on one
PVC. Deliberately minimal, and worth being explicit about what that means:

- **No HA.** One replica, no streaming replication, no failover. Node drain or
  pod eviction is a hard outage until it reschedules. Raising `replicas` does
  not help — a second pod would `initdb` its own empty PVC and serve a
  *different* database behind the same Service name.
- **No backups, no PITR.** Nothing is being captured anywhere. The PVC is the
  only copy. Data survives pod restarts and rescheduling; it does not survive a
  deleted or corrupted volume. Take a dump before anything risky:

```bash
kubectl -n eka-care exec sts/ekascribe-postgres -- pg_dump -U scribe scribe | gzip > scribe-$(date +%F).sql.gz
```

- **Encryption at rest is whatever the StorageClass provides** — Postgres does
  nothing about it here. Confirm the class actually encrypts before this holds
  patient data, and remember `pg_dump` output above lands unencrypted on your
  laptop.
- **The password sits in a plain Secret**, base64 not encrypted, readable by
  anyone with `get secrets` in this namespace. Cluster-level encryption at rest
  for etcd, or an external secrets operator, is a separate decision.

A `pg_dump`-to-S3 CronJob is the obvious next step and is not included.

## Re-running the migration

Job specs are mostly immutable, so re-applying after an image change fails:

```bash
kubectl -n eka-care delete job ekascribe-migrate --ignore-not-found && kubectl apply -f deploy/k8s/06-migrate-job.yaml
```

## Troubleshooting

`ImagePullBackOff` / `pull access denied` — the pull secret is missing, wrong,
or in the wrong namespace (secrets are namespaced; one in `default` won't be
found). Verify it independently:

```bash
kubectl -n eka-care run pullcheck --rm -i --restart=Never --image=ekacare/ekascribe:api-latest --overrides='{"spec":{"imagePullSecrets":[{"name":"ekascribe-regcred"}]}}' --command -- /app/.venv/bin/python -c "print('pull ok')"
```

The migrate Job does more than migrate — `setup.py` also probes the database,
does a real write/read/delete against S3, applies the schemas, seeds templates,
and round-trips a job through the queue. Any one failing exits 1, so the Job is
a genuine end-to-end config check. It names the failing step:

```bash
kubectl -n eka-care logs job/ekascribe-migrate
```

- `[FAIL] postgres` / `Database unreachable` → check in this order: the
  `ekascribe-postgres-0` pod is Running, its PVC is Bound (`Pending` means no
  default StorageClass — set `storageClassName` in
  `05-postgres-statefulset.yaml`), and the password in `DATABASE_URL` matches
  `POSTGRES_PASSWORD`. The Job's `wait-for-postgres` initContainer blocks until
  the server answers, so a Job stuck in `Init:0/1` is a database that never
  came up, not a migration problem.
- `[FAIL] storage` → S3 credentials or bucket. Note that the storage probe in
  `scripts/setup.py` writes to a **hardcoded** bucket named `voice-records`,
  not to whatever `S3_BUCKET` says. If you point `S3_BUCKET` somewhere else,
  the probe still expects `voice-records` to exist and be writable.
- `[FAIL] queue` → the procrastinate schema didn't apply; usually a database
  permissions problem.

Confirm the api came up in the expected mode:

```bash
kubectl -n eka-care logs deploy/ekascribe-api | grep -i "background job runner\|api configured"
```

Run this in order
```
kubectl apply -f deploy/k8s/01-configmap.yaml
kubectl apply -f deploy/k8s/04-postgres-service.yaml -f deploy/k8s/05-postgres-statefulset.yaml
kubectl -n eka-care rollout status statefulset/ekascribe-postgres
kubectl apply -f deploy/k8s/06-migrate-job.yaml     # schema + seed templates (replaces setup.py step)
kubectl -n eka-care wait --for=condition=complete job/ekascribe-migrate --timeout=300s
kubectl apply -f deploy/k8s/10-api-deployment.yaml -f deploy/k8s/11-api-service.yaml
```