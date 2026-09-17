# Path 3 — AWS ECS, no Kubernetes

For an AWS client who does not want to run Kubernetes. One `tofu apply` builds the infrastructure and runs
vaarta, because ECS has no Helm. This is the one path where OpenTofu deploys the application itself.

It uses the same image and the same settings as the other paths, and the same AWS services as the EKS path:
RDS, S3, Secrets Manager, an Application Load Balancer and a WAF.

## The shape, and one thing to know first

vaarta runs on **Fargate**, so there are no servers to patch. **Fargate has no GPU**, in any region, so
parrotlet-a cannot run there. With `gpu_model = true` this stack adds an EC2 capacity provider to the same
ECS cluster: a fixed set of GPU instances that run only the model, with vaarta reaching it over private DNS.

That trade is the whole decision on this path:

| | `gpu_model = false` (default) | `gpu_model = true` |
|---|---|---|
| Speech | Eka's hosted endpoint | parrotlet-a, in your account |
| Servers you manage | none | the GPU instances: patching, and the hourly cost whether busy or not |
| Recordings leave your network | yes, to the model endpoint | no |

If recordings may leave your network, leave it false. It is much less to operate.

## 1. Push the image to ECR

The nodes pull from ECR with no credentials, which is why the image goes there rather than being pulled from
Docker Hub at runtime.

```bash
REGION=ap-south-1
REG=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com
aws ecr create-repository --region "$REGION" --repository-name vaarta 2>/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REG"
docker tag ekacare/ekascribe:api-latest "$REG/vaarta:api-latest"
docker push "$REG/vaarta:api-latest"
```

`cpu_architecture` defaults to `X86_64`, so push the amd64 image. Push arm64 and set
`cpu_architecture = "ARM64"` instead for about 20% less on Fargate. A mismatch is reported by Fargate as a
stopped task rather than a clear error.

## 2. If you want the model: store the Docker Hub credentials

Skip this with `gpu_model = false`. The model image is private, and ECS reads registry credentials from
Secrets Manager rather than from a file:

```bash
aws secretsmanager create-secret --region "$REGION" --name acme-ecs/dockerhub \
  --secret-string '{"username":"ekacare","password":"<access token>"}' \
  --query ARN --output text
```

That ARN goes into `model_image_credentials_arn`.

## 3. Build it

```bash
cd self-host/tofu/ecs
cp terraform.tfvars.example terraform.tfvars && $EDITOR terraform.tfvars   # name, image, and gpu_model
tofu init
tofu plan                 # read it: this is everything that will exist in your account
tofu apply
```

About fifteen minutes, most of it RDS. The apply waits until the service is healthy behind the load
balancer, so it fails rather than reporting a success you do not have.

## 4. Run the migration

OpenTofu does not run it, on purpose: a migration that failed inside `apply` would leave the service
half-released. Run it now, and again after every image upgrade:

```bash
export REGION=$(tofu output -raw region) CLUSTER=$(tofu output -raw cluster_name)
TASK=$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" --launch-type FARGATE \
  --task-definition "$(tofu output -raw task_definition_family)" \
  --network-configuration "$(tofu output -raw run_task_network_configuration)" \
  --overrides "$(tofu output -raw migrate_overrides)" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK"
aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].containers[0].[exitCode,reason]' --output text        # 0
```

The migration runs `migrations,queue,seed` and skips the storage probe, which writes to a bucket with a
hardcoded name that exists only in a local MinIO.

## 5. Check it

```bash
URL=$(tofu output -raw url)
curl -s -o /dev/null -w 'healthz %{http_code}\n' "$URL/healthz"                                  # 200
curl -s -o /dev/null -w 'app     %{http_code}\n' "$URL/"                                         # 200
curl -s -o /dev/null -w 'waf     %{http_code}\n' -H 'X-Api-Version: ${jndi:ldap://x/a}' "$URL/"  # 403
aws logs tail "$(tofu output -raw log_group)" --region "$REGION" --since 15m
```

A 200 on `/healthz` does not prove the app can reach its database, because that endpoint does not check.
The migration exiting 0 does.

With `gpu_model = true`, the model takes much longer to arrive than the app: an instance boots, then pulls a
24 GB image, then loads the model. Twenty to forty minutes from a cold start. Watch it:

```bash
aws logs tail "$(tofu output -raw model_log_group)" --region "$REGION" --follow
```

Until it is ready, speech requests fail while the rest of the app works normally.

With no domain the app is on plain HTTP, and browsers allow the microphone only over HTTPS or on localhost.
A recording demo needs `domain` set.

## Upgrade

Change `image` in `terraform.tfvars`, `tofu apply`, then run step 4 again. ECS replaces tasks one at a time
and rolls back a release whose tasks never become healthy. Rolling back by hand is the previous tag and
another apply.

## Remove

```bash
REGION=$(tofu output -raw region); B=$(tofu output -raw bucket)

# 1. the bucket, which is versioned: OpenTofu will not delete one that still holds anything.
#    This destroys every recording.
while :; do
  OBJS=$(aws s3api list-object-versions --bucket "$B" --max-items 1000 --output json \
    --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}, Quiet: `true`}')
  [ "$(echo "$OBJS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["Objects"] or []))')" = 0 ] && break
  aws s3api delete-objects --bucket "$B" --delete "$OBJS" > /dev/null
done

# 2. the database's deletion protection, deliberately a separate command
aws rds modify-db-instance --region "$REGION" --db-instance-identifier "$(tofu output -raw rds_identifier)" \
  --no-deletion-protection --apply-immediately

# 3. everything else
tofu destroy
```

Destroying RDS leaves a final snapshot named `final-<name>-pg-…`, billed as storage until you delete it.
It is the last copy of the data, kept on purpose.

## Limits of this path

- **One task.** vaarta runs its job queue in-process, which loses jobs on restart and does not share work
  across tasks. Keep `desired_count = 1` until worker mode is the supported default.
- **No shell into tasks.** ECS Exec is off; debugging is through the CloudWatch log.
- **The GPU instances are fixed.** One model per instance, no autoscaling, because a model wants a whole GPU.
- **Notes still come from Eka's endpoint** even with `gpu_model = true`, which runs the speech model only.

## When it goes wrong

- **The apply fails waiting for a healthy service** — the reason is in the app log group, not in the
  OpenTofu output.
- **`InsufficientDBInstanceCapacity`** — that AZ has no capacity for that instance class right now. Change
  `rds_instance_class` and apply again.
- **Model tasks stay PENDING** — no GPU instance has registered with the cluster. Check the Auto Scaling
  group actually launched something; on a new account this is usually the `Running On-Demand G and VT
  instances` quota (`L-DB2E81BA`), which starts at 0.
- **`CannotPullContainerError` on the model** — `model_image_credentials_arn` is missing or wrong. The
  secret must hold a JSON object with `username` and `password`.
