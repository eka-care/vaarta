#!/usr/bin/env bash
#
# Build and push ekascribe images to Docker Hub, then roll them out.
#
#   ./deploy/push.sh v1.2.3                build + push, apply the ConfigMap, then
#                                          roll the deployment to api-v1.2.3
#   ./deploy/push.sh v1.2.3 --context openweb
#                                          same, with kubectl pinned to the openweb context
#   ./deploy/push.sh v1.2.3 --push-only    build + push to Docker Hub only -- the
#                                          cluster is left alone
#   LATEST=false ./deploy/push.sh v1.2.3   skip the :api-latest tag
#
# Everything lands in ONE repo with component-prefixed tags, e.g.
#   ekacare/ekascribe:api-1a2b3c4   ekacare/ekascribe:api-latest
# The api image also contains the static web bundle (relative URLs — nothing
# baked in), so there is no separate web image.
#
# The repo is private -- `docker login` first, and the cluster needs a matching
# image pull secret (see deploy/k8s/README.md).
#
# Images are only ever built on the main branch: what ships to the cluster has
# to be reproducible from main, so a build off a feature branch is refused
# (BRANCH= overrides the required branch; REQUIRE_BRANCH=false skips the check).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DOCKERHUB_REPO="${DOCKERHUB_REPO:-ekacare/ekascribe}"
# Every mode pushes -- the rollout needs the image pullable from the registry,
# and --push-only exists precisely to push -- so there is no build-only path.
LATEST="${LATEST:-true}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
BUILDER_NAME="${BUILDER_NAME:-ekascribe-builder}"

# The default run rolls the new image out: apply the ConfigMap, then set the
# image on the deployment. The ConfigMap goes first so the new pods come up
# already reading the current config -- pods only pick up env-var changes on
# restart, and this rollout is that restart. --push-only turns this off.
# NOTE: /data/storage rides an emptyDir (the Cinder PVC is commented out in
# deploy/k8s/10-api-deployment.yaml -- single-attach, see that file), so the
# rollout wipes it.
UPDATE_IMAGE="${UPDATE_IMAGE:-true}"
CONFIGMAP_FILE="${CONFIGMAP_FILE:-$REPO_ROOT/deploy/k8s/01-configmap.yaml}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-10m}"

# Docker images are built from main only. BRANCH names the required branch;
# REQUIRE_BRANCH=false disables the check entirely (escape hatch for hotfixes).
REQUIRE_BRANCH="${REQUIRE_BRANCH:-true}"
BRANCH="${BRANCH:-main}"

NAMESPACE="${NAMESPACE:-eka-care}"
# --context <name> / KUBE_CONTEXT: kubectl context for every cluster call
# (configmap apply, set image). Empty = current context.
KUBE_CONTEXT="${KUBE_CONTEXT:-}"

ALL_COMPONENTS=(api)

info() { printf '>> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
usage: ./deploy/push.sh <tag> [--push-only] [--context <name>]

  <tag>           image tag, e.g. v1.2.3 or 1a2b3c4. Builds the api image
                  (API + static web UI): ekacare/ekascribe:api-<tag>, pushes
                  it, `kubectl apply`s the ConfigMap
                  (deploy/k8s/01-configmap.yaml), `kubectl set image`s the
                  deployment to api-<tag>, and waits for the rollout. This is
                  the default -- a bare run deploys. No storage backup is
                  taken: /data/storage is an emptyDir and the rollout wipes it.
  --push-only     build and push to Docker Hub, then stop. The ConfigMap is
                  not applied and the deployment is not touched; the rollout
                  command is printed for you to run later.
  --context <name>
                  kubectl context for every cluster call (configmap apply,
                  set image), e.g. --context openweb.
                  Default: the kubeconfig's current context. If the name (or
                  the current context) doesn't exist, the available contexts
                  are listed and you're prompted to pick one; connectivity to
                  the cluster + ns access is verified before anything runs.

env overrides:
  LATEST=false          don't also tag :api-latest
  PLATFORMS=...         default linux/amd64; a comma-separated list uses buildx
  DOCKERHUB_REPO=...    default ekacare/ekascribe
  NAMESPACE=...         default eka-care
  KUBE_CONTEXT=...      same as --context (the flag wins)
  CONFIGMAP_FILE=...    default deploy/k8s/01-configmap.yaml (applied before
                        every rollout)
  ROLLOUT_TIMEOUT=...   default 10m (rollout wait)
  BRANCH=...            branch images may be built from (default: main)
  REQUIRE_BRANCH=false  skip the branch check entirely
EOF
}

dockerfile_for() {
  case "$1" in
    api)    printf '%s\n' "$REPO_ROOT/deploy/Dockerfile.api" ;;
    *)      return 1 ;;
  esac
}

# Images are built from main only. Silent outside a git checkout (the script
# still works from a tarball) and skippable with REQUIRE_BRANCH=false, but a
# checkout sitting on another branch is a hard stop: a tag built there does not
# correspond to anything on main.
check_branch() {
  [[ "$REQUIRE_BRANCH" == "true" ]] || { warn "REQUIRE_BRANCH=false -- skipping the '$BRANCH' branch check"; return 0; }
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0

  local current
  current="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [[ "$current" == "$BRANCH" ]] && return 0
  [[ "$current" == "HEAD" ]] \
    && die "detached HEAD -- images are built from '$BRANCH' only (REQUIRE_BRANCH=false to override)"
  die "on branch '$current' -- images are built from '$BRANCH' only; merge first, or REQUIRE_BRANCH=false to override"
}

preflight() {
  check_branch

  command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (is it running? are you in the docker group?)"

  # Uses `status --porcelain` rather than `diff --quiet HEAD` on purpose:
  # untracked files are part of the build context too, so an image built with
  # them does not correspond to the bare commit. Gitignored files are excluded,
  # so a local .env does not permanently mark every build dirty. Silent outside
  # a git checkout -- the script still works from a tarball.
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
    warn "working tree is dirty -- '$TAG' will not correspond to a clean commit"
  fi

  local cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  # Credential helpers leave "auths" empty, so a miss here is not proof of
  # anything -- warn rather than fail, and let the push report the truth.
  if ! grep -qs 'index\.docker\.io' "$cfg"; then
    warn "no Docker Hub credentials found in $cfg -- run 'docker login' if the push fails"
  fi
}

ensure_builder() {
  if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    info "creating buildx builder '$BUILDER_NAME' (docker-container driver, needed for multi-arch)"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
  fi
}

build_component() {
  local component="$1" dockerfile
  dockerfile="$(dockerfile_for "$component")" || die "unknown component '$component' (want: ${ALL_COMPONENTS[*]})"
  [[ -f "$dockerfile" ]] || die "missing $dockerfile"

  local tags=("${DOCKERHUB_REPO}:${component}-${TAG}")
  [[ "$LATEST" == "true" ]] && tags+=("${DOCKERHUB_REPO}:${component}-latest")

  local tag_args=() t
  for t in "${tags[@]}"; do tag_args+=(-t "$t"); done

  # Expanded below as ${build_args[@]+"${build_args[@]}"}: bash 3.2 (what macOS
  # ships) treats "${empty[@]}" as unbound under `set -u`, and api passes no
  # build args.
  local build_args=()

  if [[ "$PLATFORMS" == *,* ]]; then
    # Multi-arch images can't be loaded into the local daemon -- buildx pushes
    # the manifest list directly.
    ensure_builder
    info "buildx $component [$PLATFORMS] -> ${tags[*]}"
    docker buildx build --builder "$BUILDER_NAME" --platform "$PLATFORMS" \
      -f "$dockerfile" ${build_args[@]+"${build_args[@]}"} "${tag_args[@]}" --push "$REPO_ROOT"
  else
    info "build $component [$PLATFORMS]"
    docker build --platform "$PLATFORMS" \
      -f "$dockerfile" ${build_args[@]+"${build_args[@]}"} "${tag_args[@]}" "$REPO_ROOT"
    for t in "${tags[@]}"; do
      info "push $t"
      docker push "$t"
    done
  fi

  PUSHED_TAGS+=("${tags[@]}")
}

# Every kubectl call goes through this so --context applies uniformly.
kctl() {
  kubectl ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"} "$@"
}

# List available contexts and prompt until a valid one is chosen. Prompts on
# stderr so it works inside $( ); non-interactive runs die with the list.
pick_context() {
  local contexts="$1" choice
  [[ -t 0 ]] || die "not a tty -- pass a valid --context; available:
$contexts"
  printf 'available contexts:\n%s\n' "$contexts" >&2
  while :; do
    printf 'context to use: ' >&2
    IFS= read -r choice || die "no context chosen"
    [[ -z "$choice" ]] && continue
    if printf '%s\n' "$contexts" | grep -qx "$choice"; then
      printf '%s\n' "$choice"
      return 0
    fi
    printf "'%s' is not in the list, try again\n" "$choice" >&2
  done
}

# Resolve the kubectl context and prove the cluster is usable, once per run.
# --context wins; otherwise the kubeconfig's current context. An unknown
# context (or no current one) lists what exists and prompts for a choice.
# The probe lists pods in $NAMESPACE -- the one permission every flow here
# needs -- so it catches a down tunnel AND missing RBAC in one shot.
CLUSTER_CHECKED=false
ensure_cluster() {
  [[ "$CLUSTER_CHECKED" == "true" ]] && return 0
  command -v kubectl >/dev/null 2>&1 || die "kubectl not found on PATH"

  local contexts
  contexts="$(kubectl config get-contexts -o name 2>/dev/null)"
  [[ -n "$contexts" ]] || die "no contexts in your kubeconfig -- is KUBECONFIG pointing at the right file?"

  if [[ -n "$KUBE_CONTEXT" ]]; then
    if ! printf '%s\n' "$contexts" | grep -qx "$KUBE_CONTEXT"; then
      warn "context '$KUBE_CONTEXT' not found in kubeconfig"
      KUBE_CONTEXT="$(pick_context "$contexts")"
    fi
  elif ! kubectl config current-context >/dev/null 2>&1; then
    warn "no --context given and no current context in kubeconfig"
    KUBE_CONTEXT="$(pick_context "$contexts")"
  fi

  local label="${KUBE_CONTEXT:-$(kubectl config current-context)}"
  info "kubectl context: $label"
  kctl -n "$NAMESPACE" get pods -o name --request-timeout=10s >/dev/null 2>&1 \
    || die "cannot list pods in ns '$NAMESPACE' on context '$label' -- tunnel/Tailscale down, or RBAC?"
  info "cluster reachable, ns '$NAMESPACE' accessible"
  CLUSTER_CHECKED=true
}

# Names of the Running api pods, one per line (empty if none / no cluster).
api_pods() {
  kctl -n "$NAMESPACE" get pod -l app.kubernetes.io/name=ekascribe-api \
    --field-selector=status.phase=Running \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true
}

# Apply deploy/k8s/01-configmap.yaml on every image update, so the config the
# new pods read is always the one in the repo. Runs before `set image`: the
# rollout that follows is what makes the pods pick the new values up.
apply_configmap() {
  [[ -f "$CONFIGMAP_FILE" ]] || die "missing $CONFIGMAP_FILE"
  info "apply $CONFIGMAP_FILE"

  # kubectl says "configured" when the object actually changed and "unchanged"
  # when it didn't -- keep that word so the summary at the end is honest about
  # whether this run moved the config or just re-asserted it.
  local out
  out="$(kctl -n "$NAMESPACE" apply -f "$CONFIGMAP_FILE" 2>&1)" \
    || die "configmap apply failed -- deployment left untouched:
$out"
  printf '%s\n' "$out"
  case "$out" in
    *unchanged*) CONFIGMAP_STATE="unchanged" ;;
    *)           CONFIGMAP_STATE="updated" ;;
  esac
}

update_image() {
  local image="${DOCKERHUB_REPO}:api-${TAG}"
  info "set image deploy/ekascribe-api api=${image}"
  kctl -n "$NAMESPACE" set image deploy/ekascribe-api "api=${image}"
  info "waiting for rollout (timeout ${ROLLOUT_TIMEOUT})"
  kctl -n "$NAMESPACE" rollout status deploy/ekascribe-api --timeout="$ROLLOUT_TIMEOUT" \
    || die "rollout did not complete -- check: kubectl -n $NAMESPACE rollout status deploy/ekascribe-api"
}

main() {
  local parsed=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)      usage; exit 0 ;;
      --push-only)    UPDATE_IMAGE=false ;;
      # Rolling out is the default now; accept the old flag so muscle memory
      # and any wrapper scripts keep working.
      --update-image) warn "--update-image is the default now -- ignoring the flag" ;;
      --context)      [[ $# -ge 2 ]] || die "--context needs a value, e.g. --context openweb"
                      KUBE_CONTEXT="$2"; shift ;;
      --context=*)    KUBE_CONTEXT="${1#--context=}" ;;
      -*)             usage >&2; exit 2 ;;
      *)              parsed+=("$1") ;;
    esac
    shift
  done
  set -- ${parsed[@]+"${parsed[@]}"}

  if [[ $# -ne 1 ]]; then
    usage >&2
    exit 2
  fi

  TAG="$1"

  # The old form selected components positionally. A bare `./push.sh api` is
  # now indistinguishable from a tag named "api" -- reject it rather than
  # publish ekacare/ekascribe:api-api off stale muscle memory.
  local c
  for c in "${ALL_COMPONENTS[@]}"; do
    if [[ "$TAG" == "$c" ]]; then
      die "'$TAG' is a component name, not a tag -- both components are always built now; try: ./deploy/push.sh v1.2.3"
    fi
  done

  # Docker's own tag grammar. Checking here beats discovering it after a full
  # build, when the push is the thing that fails.
  [[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] \
    || die "'$TAG' is not a valid docker tag (start alnum/_, then alnum . _ -, max 128 chars)"

  PUSHED_TAGS=()
  CONFIGMAP_STATE=""

  preflight
  # Resolve the context and prove the cluster is usable BEFORE the slow
  # build/push, not 10 minutes into it.
  [[ "$UPDATE_IMAGE" == "true" ]] && ensure_cluster

  info "repo: $DOCKERHUB_REPO   tag: $TAG   components: ${ALL_COMPONENTS[*]}"
  [[ "$UPDATE_IMAGE" == "true" ]] || info "--push-only -- the cluster will not be touched"

  for c in "${ALL_COMPONENTS[@]}"; do
    build_component "$c"
  done

  echo
  info "pushed:"
  local t
  for t in "${PUSHED_TAGS[@]}"; do printf '     %s\n' "$t"; done

  if [[ "$UPDATE_IMAGE" == "true" ]]; then
    echo
    apply_configmap
    update_image
    echo
    if [[ "$CONFIGMAP_STATE" == "updated" ]]; then
      info "*** ConfigMap UPDATED: $CONFIGMAP_FILE applied to ns '$NAMESPACE'"
      info "    the new pods came up reading it -- re-check anything that depends on those values"
    else
      info "ConfigMap already up to date ($CONFIGMAP_FILE, ns '$NAMESPACE') -- nothing changed"
    fi
    info "deployment now on ${DOCKERHUB_REPO}:api-${TAG}"
  else
    echo
    info "nothing deployed (--push-only). roll out the immutable tags with:"
    for c in "${ALL_COMPONENTS[@]}"; do
      printf '     kubectl%s -n %s set image deploy/ekascribe-%s %s=%s:%s-%s\n' \
        "${KUBE_CONTEXT:+ --context $KUBE_CONTEXT}" "$NAMESPACE" \
        "$c" "$c" "$DOCKERHUB_REPO" "$c" "$TAG"
    done
  fi
}

main "$@"
