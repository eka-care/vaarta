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

## Modes and branding

The same image runs as a meeting/notes scribe or a clinical scribe:

```
APP_MODE=general   # default — 4 generic section tools, GoI meeting templates
APP_MODE=medical   # + 8 clinical section tools (medications, vitals, labs, diagnosis…),
                   #   clinical system prompt, templates: Clinical Notes / SOAP / Prescription Print
APP_NAME=Vaarta    # display name (title, login page, sidebar, print header) — no rebuild needed
```

```bash
make start MODE=medical         # local: pins APP_MODE in .env, builds, seeds medical templates, starts
make start-prod MODE=medical    # prod VM, same
make reseed MODE=general        # switch an existing DB: wipe the template directory, seed the mode's
                                # templates, restart api (users/sessions/custom templates untouched)
make reset-db MODE=medical      # DESTRUCTIVE: drop postgres + storage volumes and start fresh
```
(`reseed-prod` / `reset-db-prod` for the prod compose file.)

Everything mode-specific lives under `apps/api/src/scribe/modes/<mode>/`
(profile, prompts, `tool_prompts.yaml`, `seed_data.yaml`); the structuring
engine in `scribe/structuring/` is shared. `scripts/setup.py` seeds the
active mode's templates (`seed_mode: replace` archives directory templates
of the other mode). The frontend reads `app_name`/`app_mode` from
`GET /connect-auth/v1/auth-mode` at startup.

## Docs

- `docs/architecture.md` — how the pieces fit
- `CONTRIBUTING.md` — dev workflow