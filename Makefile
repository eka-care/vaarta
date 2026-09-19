.PHONY: install setup dev api worker web test lint up down start start-prod mode reseed reseed-prod reset-db reset-db-prod

install:
	uv sync --all-packages

setup:
	uv run python scripts/setup.py

api:
	uv run uvicorn scribe.main:app --reload --port 8000

web:
	npm run dev --workspace apps/web

worker:
	uv run procrastinate --app scribe_worker.main.queue_app worker

dev: ## api + worker natively against dockerized postgres
	docker compose -f deploy/docker-compose-local.yml up -d postgres
	$(MAKE) -j2 api worker

test:
	uv run pytest

lint:
	uv run ruff check .

up:
	docker compose -f deploy/docker-compose-local.yml up --build

down:
	docker compose -f deploy/docker-compose-local.yml down


COMPOSE = docker compose -f deploy/docker-compose-local.yml

# --- Product mode ---------------------------------------------------------
# MODE=general|medical on any target below pins APP_MODE in .env before the
# stack starts (the api container reads .env). Without MODE the .env value
# (default: general) is used. Switching mode on an existing DB: run
# `make reseed MODE=<mode>` (or reseed-prod) afterwards so the template
# directory matches the mode.
MODE ?=
mode: ## pin APP_MODE=$(MODE) in .env (no-op when MODE is empty)
	@[ -z "$(MODE)" ] || { \
	  case "$(MODE)" in general|medical) ;; *) echo ">> MODE must be general or medical (got '$(MODE)')"; exit 1;; esac; \
	  [ -f .env ] || cp .env.example .env; \
	  if grep -q '^APP_MODE=' .env; then sed -i.bak 's/^APP_MODE=.*/APP_MODE=$(MODE)/' .env && rm -f .env.bak; \
	  else printf '\nAPP_MODE=%s\n' "$(MODE)" >> .env; fi; \
	  echo ">> APP_MODE=$(MODE) pinned in .env"; }

start: mode ## one command: build image (API + web UI) + init DB + start postgres/api (in-process default). MODE=general|medical
	@[ -f .env ] || { cp .env.example .env; echo ">> created .env from .env.example — add SARVAM_API_KEY + your LLM key before real use"; }
	$(COMPOSE) up -d --build postgres
	$(COMPOSE) build api
	$(COMPOSE) run --rm api uv run python scripts/setup.py --non-interactive --no-env --skip-model-check --no-serve-check
	$(COMPOSE) up -d api
	@echo ">> ekascribe running — app + api: http://localhost:8000"
	@echo ">>   (in-process mode; no worker. logs: $(COMPOSE) logs -f api)"

COMPOSE_PROD = docker compose -f deploy/docker-compose-prod.yml

start-prod: mode ## prod VM: build image (API + web UI) + init DB + start stack. Needs .env with keys, ENV=prod, SELF_URL=https://<your-domain>. MODE=general|medical
	@[ -f .env ] || { cp .env.example .env; echo ">> created .env from .env.example — set API keys, ENV=prod and SELF_URL=https://<your-domain>, then re-run"; exit 1; }
	@grep -q "^ENV=prod" .env || echo ">> WARNING: ENV is not 'prod' in .env"
	@grep -q "^SELF_URL=https://" .env || echo ">> WARNING: SELF_URL in .env is not an https:// URL — browser-facing upload/session URLs derive from it"
	$(COMPOSE_PROD) up -d --build postgres
	$(COMPOSE_PROD) build api
	$(COMPOSE_PROD) run --rm api uv run python scripts/setup.py --non-interactive --no-env --skip-model-check --no-serve-check
	$(COMPOSE_PROD) up -d api
	@echo ">> ekascribe (prod) running — app + api on container port 8000"
	@echo ">>   front it with your HTTPS proxy (mic needs a secure context). logs: $(COMPOSE_PROD) logs -f api"

# --- Re-seed / reset --------------------------------------------------------
# reseed: wipe the template directory (both modes' wid=DEFAULT rows) and clear
# users' template selections, then seed the current APP_MODE's templates and
# restart the api. Keeps users, sessions, documents and custom templates.
reseed: mode ## clean the template directory + seed for APP_MODE (MODE=general|medical). Keeps sessions/users.
	$(COMPOSE) run --rm api uv run python scripts/setup.py --non-interactive --no-env --only seed --reset-templates
	$(COMPOSE) restart api
	@echo ">> re-seeded templates for APP_MODE=$$(grep '^APP_MODE=' .env | cut -d= -f2 || echo general)"

reseed-prod: mode ## same as reseed, prod compose
	$(COMPOSE_PROD) run --rm api uv run python scripts/setup.py --non-interactive --no-env --only seed --reset-templates
	$(COMPOSE_PROD) restart api
	@echo ">> re-seeded templates for APP_MODE=$$(grep '^APP_MODE=' .env | cut -d= -f2 || echo general)"

# reset-db: DESTROYS the Postgres volume + local storage/logs volumes and
# rebuilds from scratch (schema, seeds for APP_MODE). All users, sessions and
# recordings are gone — dev/test only.
reset-db: mode ## DESTRUCTIVE: drop all data (postgres + storage volumes) and start fresh for APP_MODE
	$(COMPOSE) down -v
	$(MAKE) start MODE=$(MODE)

reset-db-prod: mode ## DESTRUCTIVE: same with prod compose
	$(COMPOSE_PROD) down -v
	$(MAKE) start-prod MODE=$(MODE)
