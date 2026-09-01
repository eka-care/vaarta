#!/usr/bin/env bash
#
# Publish a release to eka-artifact-serving from what the pipeline already
# put on S3 -- without re-running the pipeline.
#
# The build jobs sign and notarize, then `deploy` syncs to S3 BEFORE it
# publishes. So whenever the publish step fails, S3 already holds a complete,
# signed release: nothing needs rebuilding, it only needs pushing.
#
#   export VARTA_ARTIFACT_PUSH_TOKEN=...
#   ./publish-from-s3.sh 1.0.5              # -> stable  (prod prefix)
#   ./publish-from-s3.sh 1.0.6 preprod dev  # -> preprod (dev prefix)
#
# Resumable: every file is HEADed first and skipped when it is already stored
# at the same size. A run that dies partway through re-uploads only what is
# missing, which matters -- the installer is ~278MB and the link to the client
# host is slow.
#
# Idempotent up to the publish: the service accepts re-PUTs of a version no
# channel points at yet, and returns 409 once it is published. That 409 is the
# guard working, not a failure to route around.

set -euo pipefail

VERSION=${1:?usage: publish-from-s3.sh <version> [channel] [s3-prefix]}
CHANNEL=${2:-stable}
PREFIX=${3:-prod}

BUCKET=${S3_BUCKET:-vaarta-app}
BASE=${ARTIFACTS_BASE_URL:-https://vaarta.bharatai.gov.in}
KEY=${VARTA_ARTIFACT_PUSH_TOKEN:?export VARTA_ARTIFACT_PUSH_TOKEN first}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say() { printf '>> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- refuse to touch a version that is already live ---------------------------
# Re-PUTting a published version would change bytes under clients mid-download.
published=$(curl -fsS --max-time 30 "${BASE}/artifacts/builds" \
  | python3 -c 'import sys,json;print(" ".join(json.load(sys.stdin)["published"]))')
for v in $published; do
  [ "$v" = "$VERSION" ] && die "$VERSION is already published; publish a new version instead"
done

# --- pull the signed artifacts off S3 ----------------------------------------
# Layout is nested (windows/, mac/arm64/) with the manifests at the version
# root. The service wants a flat namespace, so everything is addressed by
# basename -- which is also exactly what latest.yml names.
say "fetching s3://${BUCKET}/${PREFIX}/${VERSION}/"
aws s3 sync "s3://${BUCKET}/${PREFIX}/${VERSION}/" "$WORK/" --only-show-errors
[ -n "$(find "$WORK" -type f -print -quit)" ] || die "nothing at s3://${BUCKET}/${PREFIX}/${VERSION}/"

# --- upload what is missing ---------------------------------------------------
while IFS= read -r f; do
  name=$(basename "$f")
  # Percent-encode: electron-builder emits "Vaarta Setup.exe" and a raw space
  # makes curl reject the URL outright. The service stores the decoded name,
  # which is what the publish gate matches against latest.yml.
  enc=$(jq -rn --arg s "$name" '$s|@uri')
  url="${BASE}/artifacts/builds/${VERSION}/${enc}"

  local_size=$(wc -c <"$f" | tr -d ' ')
  remote_size=$(curl -fsSI --max-time 30 "$url" 2>/dev/null \
    | awk 'tolower($1)=="content-length:"{print $2+0}' | tail -1)

  if [ "${remote_size:-}" = "$local_size" ]; then
    printf '   skip %-28s (%s bytes, already stored)\n' "$name" "$local_size"
    continue
  fi

  printf '   PUT  %-28s (%s)\n' "$name" "$(du -h "$f" | cut -f1)"
  curl -fsS --retry 3 --retry-connrefused --retry-delay 5 \
    -T "$f" -H "Authorization: Bearer ${KEY}" -o /dev/null "$url" \
    || die "upload failed: $name"
done < <(find "$WORK" -type f | sort)

# --- move the channel pointer -- this is the release --------------------------
# The service verifies every file named in latest.yml / latest-mac.yml is
# present before it moves the pointer, so a partial upload fails here rather
# than reaching a clinician as an update offer that 404s.
say "publishing ${VERSION} -> ${CHANNEL}"
curl -fsS -X POST \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -d "{\"version\":\"${VERSION}\"}" \
  "${BASE}/artifacts/channels/${CHANNEL}"
echo

say "verifying"
curl -fsS --max-time 30 "${BASE}/artifacts/channels/${CHANNEL}/latest.yml" | head -3
curl -fsS --max-time 30 -o /dev/null -w '   /download/win -> %{http_code} %{redirect_url}\n' \
  "${BASE}/artifacts/channels/${CHANNEL}/download/win"

say "done -- ${CHANNEL} now serves ${VERSION}"
