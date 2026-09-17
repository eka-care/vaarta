# aws-eks-vaarta — the bucket and the IAM role, on any EKS cluster

Helm installs vaarta but cannot create a bucket or an IAM role. This module creates those two things: a versioned,
KMS-encrypted S3 bucket with public access blocked, and an IRSA role trusted by `<namespace>:vaarta` that can read
and write it. It takes facts about a cluster, never the platform's state, so it works on the kit's platform, on a
cluster the client already runs, or on one built by hand .

It is a shortcut, not a requirement. `docs/aws-existing.md` says what the bucket and role must look like; make them
however you make AWS resources and skip this. It installs nothing and writes no file: copy its two outputs into
`helm/vaarta/values-aws.yaml`.

## Inputs

| Variable | Default | Notes |
|---|---|---|
| `cluster_name`, `region` | — | required; the only two facts it cannot do without |
| `namespace` / `service_account` | `eka-care` / `vaarta` | the role trusts exactly this pair; `values-aws.yaml` sets the same name |
| `oidc_provider_arn` | "" | looked up from the cluster when empty |
| `existing_bucket` | "" | a bucket you already have; only the role is created, scoped to it |
| `tags` | {} | |

## Outputs

`bucket` → `storage.s3.vadedBucket` and `nonVadedBucket`; `role_arn` → `serviceAccount.annotations`.

## Using it

```bash
cd tofu/aws-existing
cp terraform.tfvars.example terraform.tfvars   # cluster_name, region
tofu init && tofu apply && tofu output
```

Verified 2026-09-17 by planning against `dev-eks-1-29` (Mumbai), a cluster the kit did not build.

## Notes

The bucket has `force_destroy = false` on purpose: `tofu destroy` refuses while objects remain, so a teardown
cannot silently delete recordings. Empty it deliberately first — the teardown section of `docs/aws-full.md`
has the version-purge loop, which a versioned bucket needs. An `existing_bucket` is never touched by destroy.
