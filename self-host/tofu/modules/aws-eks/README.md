# tofu/modules/aws-eks — the platform

Nothing here is executed directly. Copy `tofu/aws-full`, point it at this module and run
it there — that folder is where OpenTofu is actually executed and where the state lives.

**A cluster any app can run on, and no knowledge of which app will.** It builds the VPC, EKS with a general
node group, Karpenter for everything beyond that group, RDS for
PostgreSQL 16, a regional WAF, and a Route 53 zone with an ACM wildcard certificate when a domain is set.
Anything belonging to one app — a bucket, a scoped IAM role, GPU nodes — lives in that app's
own module and its own deployment, which reads this one's outputs .

## What it installs in the cluster

Two charts, because a cluster without them cannot route traffic or grow:

| Chart | When | Why it is not a manual step |
|---|---|---|
| AWS Load Balancer Controller | always | nothing serves traffic until an Ingress can become an ALB |
| Karpenter + a default NodePool | `karpenter = true` | the fixed node group cannot grow on its own |

**App charts are never installed here** (decision 10). A failing app release must not be able to roll back a
cluster, so apps stay a person's Helm command.

Karpenter deliberately cannot launch GPU instances: its NodePool excludes the `g` families, because a model
wants one whole GPU on a node sized for it. GPU capacity is the models' own apply, `tofu/modules/aws-eks-models`,
which attaches a fixed node group and the device plugin to this or any cluster .

The `NodePool` and `EC2NodeClass` ship as a small chart in `helm-charts/karpenter-nodepool/` rather than as
`kubernetes_manifest` resources — OpenTofu cannot plan a manifest against a CRD that does not exist yet,
while Helm never reads the schema at plan time.

## Inputs

| Variable | Default | Notes |
|---|---|---|
| `name` | — | required; prefixes every resource |
| `region` | `ap-south-1` | |
| `domain` | "" | set it for a Route 53 zone and a wildcard ACM certificate; empty serves HTTP on the load balancer hostname |
| `node_instance_type` / `node_count` / `node_max` / `node_disk_size` | `t3.medium` / 2 / 6 / 50 GiB | general node group; amd64 by default. A Graviton type (`t4g`, `m7g`, `c7g` …) also works and is cheaper — the AMI follows the instance type |
| `karpenter` / `karpenter_cpu_limit` | true / 100 | Karpenter and the ceiling in vCPU for everything it may create |
| `database_name` / `database_username` | `app` / `app` | the database this platform offers |
| `rds` / `rds_instance_class` | true / `db.t4g.medium` | PostgreSQL 16 in the private subnets, open only to the nodes, TLS required, encrypted, 7-day backups, deletion protection, Postgres logs in CloudWatch for 180 days. The password lands in Secrets Manager. `false` = an app's bundled Postgres |
| `rds_multi_az` | false | standby in a second AZ |
| `rds_allocated_storage` / `rds_max_allocated_storage` | 50 / 500 GB | storage at creation / autoscaling ceiling |
| `vpc_cidr` / `az_count` | `10.60.0.0/16` / 2 | private `/20` and public `/24` subnets derive from the CIDR, so only this one value changes. Must not overlap anything you peer or VPN with |
| `single_nat` | true | one NAT gateway; false for one per AZ |
| `kubernetes_version` | `1.36` | EKS upgrades one minor version at a time |
| `alb_controller_version` / `karpenter_version` | `3.5.0` / `1.6.3` | pinned; nothing here tracks `latest` |
| `existing_vpc_id` / `existing_zone_id` | "" | bring your own; the module then skips creating them |
| `waf` | true | regional web ACL with AWS managed rules; false when the client fronts it with their own |
| `tags` | {} | merged onto everything |

## Outputs

`cluster_name`, `kubeconfig_command`, `region`, `vpc_id`, `private_subnet_ids`, `oidc_provider_arn`,
`cluster_endpoint`, `cluster_certificate_authority_data`, `node_security_group_id`,
`alb_controller_role_arn`, `waf_acl_arn`, `certificate_arn`, `domain`, `zone_id`, `zone_name_servers`,
`rds_endpoint`, `rds_secret_name`, `database_name`, `database_username`.

`oidc_provider_arn`, `private_subnet_ids` and the database names are what an app module needs;
`cluster_endpoint` and `cluster_certificate_authority_data` are what the deployment's `helm` provider needs.

## Things learned the hard way

**Node root disks are encrypted gp3, set through block device mappings**, because the node group module
ignores `disk_size` whenever it builds its own launch template — which is its default. Earlier versions of
this module silently gave every node the image's 20 GiB unencrypted root, and a GPU node could not have held
a model image.

**New EKS clusters ship with no default StorageClass**, so a volume claim naming no class waits forever. The
EBS add-on can create one, but it sets no encryption, and in an account without EBS encrypt-by-default those
volumes are unencrypted. The add-on's class is left off and the guide creates an encrypted gp3 default instead.

**The platform releases depend on the network, for destroy order.** Without that, `tofu destroy` removes the NAT
gateway in parallel with the Helm releases, Karpenter loses the AWS API, and the `EC2NodeClass` finalizer never
clears: the `karpenter-nodepool` uninstall times out and the cluster is left running. Seen on the 2026-09-16 teardown.

**Karpenter finds nothing without its discovery tags.** `karpenter.sh/discovery = <name>` goes on the private
subnets and on the node security group; both are set here, and with `existing_vpc_id` the module tags the
subnets it finds by the `internal-elb` role tag. Without them Karpenter launches nothing and says so only in
its own log.

## Use

```bash
cd tofu/aws-full
cp terraform.tfvars.example terraform.tfvars   # name and region; everything else is defaulted
tofu init && tofu plan && tofu apply
$(tofu output -raw kubeconfig_command)
```

Then install an app: every guide in `docs/` continues from exactly this point. There is deliberately no
Makefile and no install script — on someone else's cloud account, a one-word wrapper hides what is being
created.

What it costs depends on the region and the sizes; price the `tofu plan` output in the AWS Pricing Calculator.
