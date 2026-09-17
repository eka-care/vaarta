# vaarta Helm chart

Start with the [Vaarta deployment guide](../../docs/aws-existing.md) for Compose, k3s, ECS, or EKS. This page is the Helm chart reference for Kubernetes operators.

The API container serves the web UI. Postgres with pgvector and MinIO are bundled dependencies by default. For managed services, disable the matching bundled dependency and provide database or storage settings in your values file. Model endpoints are configured separately.

From the repository root, preview the Kubernetes resources without installing them:

```bash
helm template vaarta ./helm/vaarta --set ingress.host=scribe.example.com
```

This checks rendering, not cluster readiness. Follow the app deployment guide to prepare secrets, ingress, storage, and migrations before installing. [values.yaml](values.yaml) documents the available settings.

| Switch | Effect |
|---|---|
| `worker.enabled=true` | durable Postgres queue + worker Deployment (api runs the pipeline in-process otherwise) |
| `storage.backend=local` | a PVC instead of S3 — single replica only |
| `web.enabled=false` | API only; serve the web bundle from a CDN |
| `migrate.enabled=false` | skip the post-install/pre-upgrade migration Job |
| `autoscaling.enabled`, `podDisruptionBudget.enabled` | scale-mode knobs |
| `hostAliases` | when cluster DNS cannot resolve the ASR or storage host |

The chart can generate a Kubernetes Secret or use an existing one. For production, follow the app guide's secret setup and keep credentials out of committed values files.

## Verify the install

```bash
helm test vaarta -n <namespace> --logs
```

The chart ships four checks. They run only when you invoke `helm test`, never on install or upgrade,
and they use the release's own values and secrets, so they check the real install:

- **http** — the vaarta service answers `/healthz` with 200.
- **database** — the app's own credentials log in. With `database.sslmode` set, as on RDS, it also fails unless
  the session is encrypted. vaarta does not use the `vector` extension, so nothing checks for it.
- **storage** — writes, reads back and deletes an object in the app's bucket as the app. On AWS that is its
  IAM role through the ServiceAccount, with no keys; with bundled MinIO it uses the generated credentials.
- **ingress** — waits for the load balancer address on the Ingress and fetches `/healthz` through it. It needs
  a running ingress controller, and uses a read-only role scoped to this release's Ingress.

A failing test pod is kept with its logs; a passing one is removed. Turn a check off with
`tests.<name>=false`, or mirror the four images under `tests.images` for an air-gapped cluster.

