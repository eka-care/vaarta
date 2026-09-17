# aws-eks-models — GPU capacity for the models, on any EKS cluster

Helm installs the models but cannot add nodes. This module attaches a fixed-size GPU node group on the NVIDIA
image and installs the device plugin that makes `nvidia.com/gpu` schedulable. It takes facts about a cluster,
never the platform's state, so it works on the kit's platform, on a cluster the client already runs, or on one
built by hand . The platform has no GPU variables at all.

| It creates | Unless |
|---|---|
| A managed node group `<cluster>-gpu`: `gpu_nodes` × `gpu_instance_type` on `AL2023_x86_64_NVIDIA`, encrypted `gpu_disk_size` GiB root, labelled `eka.care/gpu`, tainted `nvidia.com/gpu`, fixed size | — |
| The node IAM role | `node_role_arn` names one to share |
| NVIDIA's device plugin in `kube-system`, on the GPU nodes only | `install_device_plugin = false` (EKS Auto Mode ships it) |

It installs no model: `eka-asr` and `parrotlet-t` are Helm commands in `docs/helm.md`.

## What it reads from the cluster

From `cluster_name` alone: the Kubernetes version (picks the AMI), the service CIDR (node bootstrap), the
cluster security group (node to control plane), and the subnets. Of the cluster's subnets it keeps only those
that do not assign public IPs; if none qualify it fails the plan and asks for `subnet_ids`. EKS registers the
node role with the cluster itself, so the cluster's authentication configuration is never edited.

Verified 2026-09-17 by planning against `dev-eks-1-29` (Kubernetes 1.34, authentication mode
`API_AND_CONFIG_MAP`), a cluster the kit did not build.

## Inputs

| Variable | Default | Notes |
|---|---|---|
| `cluster_name`, `region` | — | required; the only two facts it cannot do without |
| `gpu_nodes` | 1 | 1 for speech (parrotlet-a), 2 for speech and notes (parrotlet-t). One model per node, no autoscaling |
| `gpu_instance_type` | `g6.2xlarge` | one L4, 8 vCPU, 32 GiB. A `validation` rejects anything older than NVIDIA Ampere (`g4dn`) at plan time |
| `gpu_disk_size` | 200 | GiB; the model images (24 and 35 GB) are pulled onto it |
| `subnet_ids` | [] | private subnets for the nodes; empty = the cluster's own private ones |
| `node_role_arn` | "" | share an existing node role instead of creating one |
| `install_device_plugin` / `device_plugin_version` | true / `0.20.0` | |
| `tags` | {} | |

## Outputs

`gpu_nodes` (a fact for vaarta's deployment), `node_group_name`, `node_role_arn`, `subnet_ids`.

## Using it

From `tofu/aws-existing`, which takes the same facts as variables:

```hcl
cluster_name = "my-cluster"
region       = "ap-south-1"
gpu_nodes    = 1
```

The `helm` provider is configured in the deployment folder, not here, with `aws eks get-token` exec auth.

## Notes

The NVIDIA AL2023 image exists for EKS 1.29 and newer; check the SSM parameter
`/aws/service/eks/optimized-ami/<version>/amazon-linux-2023/x86_64/nvidia/recommended/image_id` for an older
cluster before applying. On a new account the `Running On-Demand G and VT instances` quota (`L-DB2E81BA`)
starts at 0 or 8 vCPU while two `g6.2xlarge` need 16; the node group then exists but launches nothing.
`tofu destroy` removes the node group and the plugin and nothing else; uninstall the model releases first.
