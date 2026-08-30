#!/usr/bin/env bash
#
# Restart ekascribe-api.
#
#   ./deploy/restart.sh                      rollout restart -> wait
#   ./deploy/restart.sh --context openweb    same, with kubectl pinned to a context
#
# Same image, same tag -- this only cycles the pods. Use deploy/push.sh <tag>
# when you actually want a new image rolled out.
#
# NOTE: /data/storage is a plain emptyDir on the node root disk (see
# deploy/k8s/10-api-deployment.yaml -- the Cinder PVC is commented out because
# it is single-attach), so this restart DOES wipe anything written there.
set -euo pipefail

NAMESPACE="${NAMESPACE:-eka-care}"
DEPLOYMENT="${DEPLOYMENT:-ekascribe-api}"
POD_SELECTOR="${POD_SELECTOR:-app.kubernetes.io/name=ekascribe-api}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-10m}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"

info() { printf '>> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
usage: ./deploy/restart.sh [--context <name>]

  (no flags)        `kubectl rollout restart` the deployment and wait for it.
                    /data/storage is an emptyDir -- the new pods start empty.
  --context <name>  kubectl context for every cluster call, e.g. openweb.
                    Default: the kubeconfig's current context.

env overrides:
  NAMESPACE=...         default eka-care
  DEPLOYMENT=...        default ekascribe-api
  POD_SELECTOR=...      default app.kubernetes.io/name=ekascribe-api
  ROLLOUT_TIMEOUT=...   default 10m
  KUBE_CONTEXT=...      same as --context (the flag wins)
USAGE
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

# Resolve the context and prove the cluster is usable before anything runs.
# The probe lists pods in $NAMESPACE -- the one permission every step needs --
# so it catches a down tunnel AND missing RBAC in one shot.
ensure_cluster() {
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
  info "kubectl context: $label   ns: $NAMESPACE   deploy: $DEPLOYMENT"
  kctl -n "$NAMESPACE" get pods -o name --request-timeout=10s >/dev/null 2>&1 \
    || die "cannot list pods in ns '$NAMESPACE' on context '$label' -- tunnel/Tailscale down, or RBAC?"
}

restart_deployment() {
  info "rollout restart deploy/$DEPLOYMENT"
  kctl -n "$NAMESPACE" rollout restart "deploy/$DEPLOYMENT"
  info "waiting for rollout (timeout ${ROLLOUT_TIMEOUT})"
  kctl -n "$NAMESPACE" rollout status "deploy/$DEPLOYMENT" --timeout="$ROLLOUT_TIMEOUT" \
    || die "rollout did not complete -- check: kubectl${KUBE_CONTEXT:+ --context $KUBE_CONTEXT} -n $NAMESPACE rollout status deploy/$DEPLOYMENT"
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)      usage; exit 0 ;;
      --context)      [[ $# -ge 2 ]] || die "--context needs a value, e.g. --context openweb"
                      KUBE_CONTEXT="$2"; shift ;;
      --context=*)    KUBE_CONTEXT="${1#--context=}" ;;
      *)              usage >&2; exit 2 ;;
    esac
    shift
  done

  ensure_cluster
  restart_deployment

  echo
  kctl -n "$NAMESPACE" get pod -l "$POD_SELECTOR" || true
  echo
  info "restarted -- /data/storage started empty on the new pods"
}

main "$@"
