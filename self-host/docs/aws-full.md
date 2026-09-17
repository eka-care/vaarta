# Path 4 — everything on AWS, from an empty account

One apply builds the network, the Kubernetes cluster, the database, the edge and the GPU nodes. Then two
Helm commands install vaarta and the model. Use this when you have an AWS account and nothing in it yet.

Already have an EKS cluster? Use [aws-existing.md](aws-existing.md) instead. It is the same app install
without rebuilding a cluster you already run.

## What gets built

| Piece | What |
|---|---|
| Network | a VPC, private and public subnets across two availability zones, one NAT gateway, an S3 gateway endpoint |
| Cluster | EKS with a managed node group, the AWS Load Balancer Controller, and Karpenter for growth beyond it |
| Database | RDS for PostgreSQL 16: private, TLS required, encrypted, backed up daily, deletion protection on |
| Edge | an internet-facing load balancer with a WAF; a Route 53 zone and an ACM certificate when you set a domain |
| GPU | a fixed GPU node group and NVIDIA's device plugin, only when `gpu_nodes` is more than 0 |
| vaarta's own | an S3 bucket for recordings, and an IAM role the pod assumes to reach it without access keys |

The apply stops there. It never installs vaarta: a failing application release must not be able to roll back
a cluster, so the app is a Helm command a person runs.

## What you need

- An AWS account and admin credentials: `aws sts get-caller-identity` works
- OpenTofu 1.6 or newer, `kubectl`, `helm`, the AWS CLI and Docker

## 1. Choose the account, out loud

This is the step that decides where a VPC and a cluster get built. Read the account number before you
continue:

```bash
export AWS_PROFILE=<your profile>
aws sts get-caller-identity
```

## 2. Build it

```bash
cd self-host/tofu/aws-full
cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars
tofu init
tofu plan                  # read it: this is the list of what will exist, and what it will cost
tofu apply
```

About twenty minutes, most of it the cluster and the database in parallel. The two values you must set are
`name` and `region`. The one worth thinking about is `gpu_nodes`: leave it 0 and speech comes from Eka's
endpoint at no GPU cost; set it to 1 to run parrotlet-a in your own cluster; 2 also runs the notes model.

Then connect `kubectl`:

```bash
$(tofu output -raw kubeconfig_command)
kubectl get nodes                                             # Ready
kubectl -n kube-system get deploy aws-load-balancer-controller karpenter
```

## 3. Push the image to ECR

The nodes pull from ECR with no credentials:

```bash
REGION=$(tofu output -json next_steps | python3 -c 'import json,sys; print(json.load(sys.stdin)["region"])')
REG=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com
aws ecr create-repository --region "$REGION" --repository-name vaarta 2>/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REG"
docker tag ekacare/ekascribe:api-latest "$REG/vaarta:api-latest"
docker push "$REG/vaarta:api-latest"
```

## 4. Put the database password in the cluster

The one thing the chart cannot fetch for itself. OpenTofu put the password in Secrets Manager rather than
creating a Kubernetes Secret, because that would mean handing OpenTofu credentials to your cluster:

```bash
NS=eka-care
kubectl create namespace "$NS"
kubectl -n "$NS" create secret generic vaarta-db --from-literal=password="$(
  aws secretsmanager get-secret-value --region "$REGION" \
    --secret-id "$(tofu output -json next_steps | python3 -c 'import json,sys; print(json.load(sys.stdin)["database_secret_name"])')" \
    --query SecretString --output text | python3 -c 'import json,sys; print(json.load(sys.stdin)["password"])')"
```

## 5. Fill the values file and install

`tofu output next_steps` prints everything the file asks for. Copy them across by hand; nothing is generated,
so this file is yours to keep in version control with the rest of your configuration. It holds no secrets.

```bash
tofu output next_steps
cp ../../helm/vaarta/values-aws.yaml .
$EDITOR values-aws.yaml        # every FILL: image repository, role ARN, database host/name/user, bucket, region
```

```bash
helm upgrade --install vaarta ../../helm/vaarta -n eka-care -f values-aws.yaml --wait --timeout 15m
```

## 6. Give it its address

The app builds browser upload URLs from `config.selfUrl` and has no fallback, so uploads fail until it is
right.

**With a domain**, you already set `ingress.host` and `selfUrl` to `https://scribe.<domain>` in step 5, and
uncommented the certificate annotations. Delegate the domain to the name servers in
`tofu output zone_name_servers` at your registrar, and you are done.

**Without a domain**, the address is the load balancer's own hostname, which exists only now:

```bash
ALB=$(kubectl -n eka-care get ingress vaarta -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
$EDITOR values-aws.yaml         # config.selfUrl: http://<that hostname>
helm upgrade vaarta ../../helm/vaarta -n eka-care -f values-aws.yaml --wait
```

## 7. Check it

```bash
helm test vaarta -n eka-care --logs      # http, database over TLS, storage through the IAM role, ingress
curl -s -o /dev/null -w 'healthz %{http_code}\n' "http://$ALB/healthz"                                 # 200
curl -s -o /dev/null -w 'waf     %{http_code}\n' -H 'X-Api-Version: ${jndi:ldap://x/a}' "http://$ALB/" # 403
```

The storage check writes, reads and deletes a real object in the real bucket as the app, through the IAM
role, with no access keys anywhere. If it passes, the role and the bucket are wired correctly.

## 8. The model, if you set gpu_nodes

```bash
kubectl get nodes -l eka.care/gpu=true                    # Ready; they take a few minutes to join
kubectl -n eka-care create secret docker-registry dockerhub \
  --docker-username=ekacare --docker-password='<access token>'

helm upgrade --install eka-asr ../../helm/parrotlet-model -n eka-care \
  -f ../../helm/parrotlet-model/values-parrotlet-a.yaml --wait --timeout 40m
helm test eka-asr -n eka-care --logs
```

Then point vaarta at it: uncomment `asr.url: ""` in `values-aws.yaml` and `helm upgrade`. Empty means the
`eka-asr` release in this namespace. With `gpu_nodes = 2`, install `parrotlet-t` the same way and uncomment
the `llm` block as well.

The 40 minute timeout is a 24 GB image pull. `Startup probe failed` during it is expected; the restart count
is what should stay at zero.

## Remove

Order matters. Three things are created by controllers inside the cluster, not by OpenTofu, and a
`tofu destroy` that runs first leaves them behind, still billing, and blocks the VPC from deleting.

```bash
# 1. the app, which deletes its load balancer
helm uninstall vaarta -n eka-care
helm uninstall eka-asr -n eka-care 2>/dev/null

# 2. wait until this prints nothing
aws resourcegroupstaggingapi get-resources --region "$REGION" \
  --tag-filters Key=elbv2.k8s.aws/cluster,Values="$(tofu output -json next_steps | python3 -c 'import json,sys;print(json.load(sys.stdin)["cluster_name"])')" \
  --resource-type-filters elasticloadbalancing:loadbalancer --query 'ResourceTagMappingList[].ResourceARN' --output text

# 3. empty the bucket: it is versioned, and this destroys every recording
#    (the loop is in ecs.md, step "Remove" — the same one)

# 4. turn off the database's deletion protection, then destroy
aws rds modify-db-instance --region "$REGION" --db-instance-identifier "<name>-pg" \
  --no-deletion-protection --apply-immediately
tofu destroy
```

Afterwards confirm the expensive things are gone, because an interrupted destroy can leave a control plane
running with no nodes and nothing to warn you:

```bash
aws eks list-clusters --region "$REGION" --query clusters --output text          # empty
aws rds describe-db-instances --region "$REGION" --query 'DBInstances[].DBInstanceIdentifier' --output text
tofu state list | wc -l                                                          # 0
```

## When it goes wrong

- **`InsufficientDBInstanceCapacity`** — that AZ has no capacity for that database class right now. Change
  `rds_instance_class` and apply again; the apply resumes where it stopped.
- **`No valid credential sources found`** — no profile exported in this shell.
- **Pods Pending and Karpenter silent** — check `kubectl -n kube-system logs deploy/karpenter`.
- **GPU nodes never Ready** — usually the `Running On-Demand G and VT instances` quota (`L-DB2E81BA`),
  which starts at 0 or 8 vCPU on a new account while one `g6.2xlarge` needs 8.
- **`tofu destroy` stuck on a subnet or the VPC** — a controller left a network interface or a security
  group behind. Delete it and the waiting destroy continues on its own.
