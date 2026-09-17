# Path 5 — vaarta on the EKS cluster you already run

You have a cluster. This adds vaarta to it and nothing else: no VPC, no node groups of yours touched, no
controllers installed, no change to how your cluster authenticates anyone.

Two things get created, because Helm cannot create them itself:

- an **S3 bucket** for recordings, and an **IAM role** the pod assumes to reach it, so there are no access keys
- **GPU nodes** and NVIDIA's device plugin, only if you want parrotlet-a running in your cluster

Everything else is a value in `values-aws.yaml` that names what you already have.

## What your cluster must already have

| Requirement | Check |
|---|---|
| An ingress controller that turns an Ingress into a load balancer | `kubectl get ingressclass` shows `alb`, or nginx, or your own |
| A PostgreSQL 16 server the pods can reach | your own RDS, Aurora, or anything else |
| Capacity for one small app | roughly 1 CPU and 2 GB, plus the model's node if you run it |

If `kubectl get ingressclass` is empty, install the AWS Load Balancer Controller first, or use whichever
controller your cluster already standardises on and set `ingress.className` to match.

**No PostgreSQL?** You do not have to bring one. Use the chart's bundled database instead by following
[helm.md](helm.md) and changing only the storage block to S3. The pieces are independent.

## 1. Create the bucket and the role

Either by hand, with whatever tooling you use for AWS, or with the shortcut below. What they must be:

**Bucket.** Any name. Versioning on, public access blocked, encryption on.

**IAM role.** A role whose trust policy names your cluster's OIDC provider and the subject
`system:serviceaccount:eka-care:vaarta`, with a policy allowing `s3:ListBucket` on the bucket and
`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on everything in it. The namespace and the service account
name must match where you install the chart, which is why `values-aws.yaml` pins the name to `vaarta`.

The shortcut needs two facts and reads the rest from the cluster:

```bash
cd self-host/tofu/aws-existing
cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars   # cluster_name, region
tofu init && tofu apply
tofu output next_steps
```

Already have a bucket? Put its name in `existing_bucket` and only the role is created, scoped to it.

## 2. Put the database password in the cluster

```bash
NS=eka-care
kubectl create namespace "$NS"
kubectl -n "$NS" create secret generic vaarta-db --from-literal=password='<the password>'
```

From Secrets Manager, if that is where yours lives:

```bash
aws secretsmanager get-secret-value --secret-id <name> --query SecretString --output text
```

## 3. Make the image reachable

The nodes pull from ECR with no credentials, so pushing it into your own account is the least friction:

```bash
REGION=<region>
REG=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com
aws ecr create-repository --region "$REGION" --repository-name vaarta 2>/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REG"
docker tag ekacare/ekascribe:api-latest "$REG/vaarta:api-latest"
docker push "$REG/vaarta:api-latest"
```

To pull from Docker Hub instead, create a `dockerhub` pull secret in the namespace and uncomment the
`imagePullSecrets` block in `values-aws.yaml`. The file says how.

Push the architecture your nodes run. A mismatch appears much later as `exec format error` in a pod log.

## 4. Fill the values file and install

```bash
cp ../../helm/vaarta/values-aws.yaml .
$EDITOR values-aws.yaml
```

Every `FILL`: the image repository, the IAM role ARN, the database endpoint, database name and user, the
bucket name and its region. If your cluster's ingress class is not `alb`, change `ingress.className` and
replace the ALB annotations with your controller's equivalents.

```bash
helm upgrade --install vaarta ../../helm/vaarta -n eka-care -f values-aws.yaml --wait --timeout 15m
```

## 5. Give it its address, then check it

With a domain, `ingress.host` and `config.selfUrl` are already set and the certificate annotations are
uncommented. Without one, read the load balancer hostname once it exists, put it in `config.selfUrl`, and
upgrade:

```bash
kubectl -n eka-care get ingress vaarta -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
$EDITOR values-aws.yaml
helm upgrade vaarta ../../helm/vaarta -n eka-care -f values-aws.yaml --wait
```

```bash
helm test vaarta -n eka-care --logs
```

The storage check writes and reads and deletes a real object in your bucket as the app, through the IAM
role. It is the one that proves the role and the trust policy are right.

## 6. The model, if you want it in your cluster

Set `gpu_nodes = 1` in `terraform.tfvars` and apply again: that adds a fixed GPU node group on the NVIDIA
image and the device plugin. On a cluster that already runs the device plugin, set
`install_device_plugin = false` so a second copy is not installed.

Bringing your own GPU nodes instead is fine. They need the label `eka.care/gpu=true`, the taint
`nvidia.com/gpu=true:NoSchedule`, an NVIDIA GPU of the Ampere generation or newer, and a disk with room for
a 24 GB image. Then:

```bash
kubectl -n eka-care create secret docker-registry dockerhub \
  --docker-username=ekacare --docker-password='<access token>'
helm upgrade --install eka-asr ../../helm/parrotlet-model -n eka-care \
  -f ../../helm/parrotlet-model/values-parrotlet-a.yaml --wait --timeout 40m
helm test eka-asr -n eka-care --logs
```

Uncomment `asr.url: ""` in `values-aws.yaml` and upgrade vaarta. Empty means the `eka-asr` release in this
namespace.

## Remove

```bash
helm uninstall vaarta -n eka-care
helm uninstall eka-asr -n eka-care 2>/dev/null
```

Wait for the load balancer to disappear, because the controller owns it and OpenTofu does not know about it.
Then empty the bucket if you want it gone, and `tofu destroy` in this folder removes the bucket, the role
and the GPU nodes. Your cluster is untouched throughout, and a bucket you brought yourself with
`existing_bucket` is never deleted.

## When it goes wrong

- **The storage test fails with access denied** — the trust policy subject does not match. It must be
  exactly `system:serviceaccount:<namespace>:vaarta`, and the namespace must be the one you installed into.
- **`ImagePullBackOff`** — the nodes cannot reach the registry, or the pull secret is missing from this
  namespace.
- **The Ingress never gets an address** — no ingress controller is watching that class. Check
  `ingress.className` against `kubectl get ingressclass`.
- **Uploads fail though the page loads** — `config.selfUrl` is not the address in the browser.
- **The model pod is Pending** — `nvidia.com/gpu` is not schedulable, so the device plugin is not running or
  the node is not labelled.
