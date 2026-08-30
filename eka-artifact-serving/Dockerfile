# Build context is THIS directory -- the service is self-contained on purpose,
# so it neither pulls in the monorepo root nor rebuilds when the api changes.
#
#   docker build -t ekacare/ekascribe:artifact-<tag> eka-artifact-serving/
#
# Nothing from the api image is here: no ffmpeg, no git, no postgres client, no
# Next bundle. This process streams files and resolves a pointer.
FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN uv pip install --system --no-cache .

ENV PORT=8080 UVICORN_WORKERS=2
EXPOSE 8080

# Uploads spool to /tmp before going to the store, so the container needs
# writable ephemeral space -- the Deployment mounts an emptyDir there.
CMD ["sh", "-c", "uvicorn eka_artifact_serving.main:app --host 0.0.0.0 --port ${PORT} --workers ${UVICORN_WORKERS}"]
