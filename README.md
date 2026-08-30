# ekascribe

On-prem, self-hostable AI scribe: record a consultation → transcribe →
structured clinical note → edit → print/copy.

## Run locally

```bash
make start
```

Builds everything, initializes the DB, and starts the stack in Docker.
App + API at http://localhost:8000. First run creates `.env` from
`.env.example` — add `SARVAM_API_KEY` and your LLM key. Stop with `make down`.

## Run in prod

On the VM, set keys, `ENV=prod`, and `SELF_URL=https://<your-domain>` in `.env`, then:

```bash
make start-prod
```

Serves on container port 8000 — front it with your HTTPS proxy (mic needs a
secure context).

## Run on Kubernetes

```bash
./deploy/push.sh <tag>          # build + push, apply the ConfigMap, roll out
                                # (--push-only to push without deploying)
kubectl apply -f deploy/k8s/    # first-time install of the rest of the manifests
kubectl -n eka-care port-forward svc/ekascribe-api 8000:8000
```

Secrets and details: `deploy/k8s/README.md`.

## Docs

- `docs/architecture.md` — how the pieces fit
- `CONTRIBUTING.md` — dev workflow