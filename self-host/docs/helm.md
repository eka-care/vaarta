# Path 2 — Helm, on any Kubernetes cluster

One `helm install` on any cluster: k3s on a single machine, a hospital's own cluster, a managed one from any
provider. The chart brings its own PostgreSQL and MinIO and generates its own secrets, so nothing has to
exist first.

If your cluster is EKS and you want RDS and S3 instead of the bundled pieces, read
[aws-existing.md](aws-existing.md) instead. This guide is the self-contained install.

## What you need

- A cluster with a default StorageClass and an ingress controller
- 4 CPU, 8 GB RAM and 40 GB of storage available to it
- Helm 3, and `kubectl` pointed at the cluster

Check the two things that are usually missing:

```bash
kubectl get storageclass          # one marked (default)
kubectl get ingressclass          # traefik, nginx, alb, whatever you run
```

Without a default StorageClass the bundled database waits forever for a volume, with no error that says so.

## 1. Let the cluster pull the image

The image is private on Docker Hub, so the cluster needs credentials:

```bash
kubectl create namespace eka-care
kubectl -n eka-care create secret docker-registry dockerhub \
  --docker-username=ekacare --docker-password='<access token>'
```

On a single-node cluster with no registry access, import the image onto the node instead. It must match the
node's architecture:

```bash
docker pull --platform linux/amd64 ekacare/ekascribe:api-latest     # match `uname -m` on the node
docker save ekacare/ekascribe:api-latest | ssh <node> 'sudo k3s ctr images import -'
```

## 2. Install

`ingress.host` is the address people will use. `config.selfUrl` is what the app puts in upload URLs, and it
must be the same address the browser is on.

```bash
helm upgrade --install vaarta ../helm/vaarta -n eka-care --create-namespace \
  --set imagePullSecrets[0].name=dockerhub \
  --set ingress.host=scribe.example.com \
  --set config.selfUrl=https://scribe.example.com \
  --wait --timeout 15m
```

Four things settle in order: PostgreSQL initialises, MinIO creates its buckets, the migration Job runs, then
vaarta becomes ready. The migration is a post-install hook, so `--wait` covers it. On a healthy install the
Job deletes itself, which is why there are no logs to read afterwards; watch it live in another shell with
`kubectl -n eka-care get pods -w`, or read `kubectl -n eka-care logs job/vaarta-migrate` when it has failed,
because failure is exactly the case where the Job is left behind.

## 3. Check it

```bash
helm test vaarta -n eka-care --logs
```

Four checks run, and only when you ask. They use the release's real values and secrets: the service answers
`/healthz`, the app's own credentials log into the database, an object is written and read back and deleted
in the real bucket, and the address on the Ingress serves `/healthz` through the ingress controller.

## Use your own database or storage

Every dependency is a value, and anything you leave alone keeps its bundled default. Bring one piece without
bringing the others.

**Your PostgreSQL, bundled MinIO:**

```yaml
postgresql:
  deploy: false
database:
  host: postgres.internal
  port: 5432
  name: scribe
  user: scribe
  existingSecret: vaarta-db      # a Secret with key `password`, created by you
  sslmode: require               # if your server requires TLS
```

```bash
kubectl -n eka-care create secret generic vaarta-db --from-literal=password='<the password>'
```

**Your S3-compatible storage, bundled PostgreSQL:**

```yaml
minio:
  deploy: false
storage:
  backend: s3
  s3:
    endpointUrl: https://storage.internal      # leave empty for real AWS S3
    region: us-east-1
    vadedBucket: vaarta-recordings
    nonVadedBucket: vaarta-recordings
    existingSecret: vaarta-s3                  # a Secret with AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
```

The database and the storage are independent: setting one does nothing to the other. This is the case where
you already run PostgreSQL but have no object storage, and the answer is to change only the database block.

## Run parrotlet-a in the cluster

Only when recordings must not leave your network. You need a node with an NVIDIA GPU of the Ampere
generation or newer, labelled and tainted so only the model lands on it, and NVIDIA's device plugin running.

```bash
kubectl label  node <gpu-node> eka.care/gpu=true
kubectl taint  node <gpu-node> nvidia.com/gpu=true:NoSchedule
helm upgrade --install nvidia-device-plugin nvidia-device-plugin \
  --repo https://nvidia.github.io/k8s-device-plugin --version 0.20.0 \
  -n kube-system -f ../helm/parrotlet-model/nvidia-device-plugin-values.yaml
```

Confirm the GPU became schedulable. Until it does, the model pod sits Pending with no useful reason given:

```bash
kubectl get nodes -l eka.care/gpu=true \
  -o jsonpath='{range .items[*]}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'     # 1
```

Then install the model and point vaarta at it. The release name matters, because that is the hostname:

```bash
helm upgrade --install eka-asr ../helm/parrotlet-model -n eka-care \
  -f ../helm/parrotlet-model/values-parrotlet-a.yaml --wait --timeout 40m

helm test eka-asr -n eka-care --logs      # asks the model for a real transcription, not just a ping
helm upgrade vaarta ../helm/vaarta -n eka-care --reuse-values --set asr.url=""
```

`asr.url=""` means "the eka-asr release in this namespace". The 40 minute timeout is the 24 GB image pull;
`Startup probe failed` events during it are expected, and the restart count is the number that should stay
at zero.

## Upgrade and remove

```bash
helm upgrade vaarta ../helm/vaarta -n eka-care --reuse-values --set image.tag=<new tag>
helm uninstall vaarta -n eka-care && kubectl delete namespace eka-care
```

Deleting the namespace is what actually removes the generated secrets: they carry a keep policy, so a
reinstall into a surviving namespace reuses the old passwords. That is the point during an upgrade and a
surprise when you meant to start clean.

## When it goes wrong

- **Pods Pending, events mention volumes** — no default StorageClass. `kubectl get sc`.
- **`ImagePullBackOff`** — the pull secret is missing, or not referenced. It must exist in the same namespace.
- **The migration Job fails** — read its log before it is cleaned up. Almost always the database credentials
  or a database that is not reachable yet.
- **Uploads fail though the page loads** — `config.selfUrl` does not match the address in the browser.
- **The model pod is Pending forever** — `nvidia.com/gpu` is not a schedulable resource, meaning the device
  plugin is not running or the node is not labelled.
