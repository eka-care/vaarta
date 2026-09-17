# Path 1 — Docker Compose, with parrotlet-a on the same machine

One machine runs everything: vaarta, PostgreSQL, MinIO for recordings, and optionally the speech model on a
GPU in that machine. Good for a demo, a single clinic, or a pilot on one VM. Not for anything that needs to
survive the machine.

## What you need

- Linux (Ubuntu 22.04 or Debian 12) or macOS, with Docker and Compose v2
- 4 CPU, 8 GB RAM, 40 GB disk for vaarta alone
- For the model as well: an NVIDIA GPU of the Ampere generation or newer (A10G, L4, A100, L40S), the NVIDIA
  driver, `nvidia-container-toolkit`, and about 100 GB more disk

A T4 will not work. The model needs compute capability 8.0 or newer.

## 1. Configure

```bash
cd self-host/compose
cp .env.example .env
```

Fill every line marked `FILL`. The generated ones want real randomness:

```bash
openssl rand -hex 32        # AUTH_JWT_SECRET, UPLOAD_URL_SIGNING_SECRET
openssl rand -hex 16        # POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD
```

`SELF_URL` must be the exact address the browser will use. The app builds recording upload URLs from it and
has no fallback, so a mismatch loads the page and then fails every upload. On a laptop that is
`http://localhost:8000`.

## 2. Start it

```bash
docker compose up -d
docker compose ps                      # vaarta and postgres both (healthy)
docker compose run --rm migrate        # schema, queue tables, seed templates
curl -fsS http://localhost:8000/healthz && echo
```

Open `http://localhost:8000`, record ten seconds, expect a note back.

**Do not trust the health check alone.** vaarta reports healthy and serves the web page even when it cannot
log into its database, because `/healthz` does not check the database. A migration that exits cleanly is the
real signal.

## 3. Add the speech model, if you have a GPU

Without this step speech goes to Eka's endpoint, which is fine unless recordings may not leave the machine.

```bash
docker login -u ekacare
docker compose --profile gpu up -d eka-asr
docker compose logs -f eka-asr                   # wait for the vLLM server to report ready
```

The first start pulls a 24 GB image and then loads the model. Allow twenty to forty minutes and do not
interpret the wait as a failure. When it answers, point vaarta at it in `.env`:

```bash
ASR_URL=http://eka-asr:8000/v1
```

then `docker compose up -d` to restart vaarta with the new value. Check the model answers on its own:

```bash
docker compose exec eka-asr curl -fsS http://127.0.0.1:8000/v1/models
```

Two settings in the Compose file are load-bearing and already correct: `shm_size: 16g`, because the 64 MB
container default breaks model load, and `--mm-processor-cache-type=shm`, without which one failed audio
request leaves vLLM's two audio caches out of step and every later request hangs while text prompts keep
answering.

## 4. HTTPS, when the machine has a name

Browsers allow microphone access only over HTTPS or on `localhost`. A plain HTTP address that is not
localhost loads the page and silently refuses to record. On a VM with a real hostname:

```bash
# .env:  DOMAIN=scribe.example.com   SELF_URL=https://scribe.example.com   AUTH_COOKIE_SECURE=true
docker compose --profile tls up -d
```

Caddy gets a certificate from Let's Encrypt on its own. Port 80 and 443 must reach the machine.

## Upgrade, back up, remove

```bash
# upgrade: change VAARTA_IMAGE in .env, then
docker compose up -d && docker compose run --rm migrate

# back up: the database, and the recordings volume
docker compose exec postgres pg_dump -U scribe scribe > backup.sql

# remove
docker compose down          # keeps the data
docker compose down -v       # deletes the database and every recording
```

## When it goes wrong

- **`manifest unknown` on `up`** — you are not logged in. `docker login -u ekacare`.
- **`exec format error`** — the image architecture does not match the machine. Re-pull with the matching
  `--platform`.
- **`password authentication failed for user "scribe"`** — an old `pgdata` volume is still there from a
  previous run with a different password. PostgreSQL only sets the password when the volume is first
  created. Put the old password back, or `docker compose down -v` and start clean.
- **The microphone never activates** — the page is not on HTTPS or localhost. See step 4.
- **The model container exits immediately** — usually no GPU visible. `docker run --rm --gpus all
  nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` should list your card.
- **Speech requests hang but text works** — the audio cache went out of step. Restart `eka-asr` and confirm
  `--mm-processor-cache-type=shm` is still in its command.
