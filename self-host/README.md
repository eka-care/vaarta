# Running vaarta on your own infrastructure

Vaarta turns a consultation recording into a structured clinical note. This folder is everything needed to
run it somewhere that is not Eka: a laptop, one server, your Kubernetes cluster, or your AWS account.

Speech recognition is done by **parrotlet-a**, a model served by vLLM on an NVIDIA GPU. By default vaarta
calls Eka's hosted endpoint for it and you need no GPU at all. Every path below can instead run parrotlet-a
on your own hardware, which is the point when recordings must not leave your network.

## Pick a path

| # | Path | You need | Speech | Guide |
|---|---|---|---|---|
| 1 | Docker Compose | one machine with Docker; a GPU for the model | on the same machine, or Eka's endpoint | [docs/compose.md](docs/compose.md) |
| 2 | Helm | any Kubernetes cluster | in the cluster on a GPU node, or Eka's endpoint | [docs/helm.md](docs/helm.md) |
| 3 | AWS ECS | an AWS account, no Kubernetes | on GPU instances beside the app, or Eka's endpoint | [docs/ecs.md](docs/ecs.md) |
| 4 | AWS, everything | an AWS account | in the cluster on a GPU node, or Eka's endpoint | [docs/aws-full.md](docs/aws-full.md) |
| 5 | AWS, your cluster | an EKS cluster you already run | in your cluster on a GPU node, or Eka's endpoint | [docs/aws-existing.md](docs/aws-existing.md) |

**Which one.** Path 1 for a demo or a single-site pilot. Path 2 when you already run Kubernetes and do not
want anything AWS-specific. Path 4 when you have an AWS account and nothing in it yet: one apply builds the
network, the cluster, the database and the GPU nodes. Path 5 is path 4 for people who already have a cluster,
and creates only the two things that are vaarta's own. Path 3 when the answer to Kubernetes is no.

Paths 4 and 5 share everything except who builds the cluster, so the guides are short and point at each other.

## What vaarta needs, on any path

| Piece | What it is for | Bundled by default? |
|---|---|---|
| PostgreSQL 16 | the database, the job queue and application state. There is no Redis | yes, except on AWS where RDS is the default |
| Object storage | recordings and generated documents, over the S3 API | MinIO locally; S3 on AWS |
| parrotlet-a | speech to text | no: Eka's endpoint, until you run it yourself |
| A structuring model | the clinical note | no: Eka's endpoint, or Anthropic, or your own |

It holds no other cloud dependency. Nothing here needs DynamoDB, a message broker, or a managed cache.

## What is in this folder

```
compose/      the Compose file, its .env.example and a Caddy config for HTTPS
helm/         the vaarta chart, the parrotlet-model chart, and values-aws.yaml for EKS
tofu/
  modules/    library code: the EKS platform, vaarta's bucket and role, GPU nodes, the whole ECS stack
  aws-full/   path 4, run OpenTofu here
  aws-existing/ path 5, run OpenTofu here
  ecs/        path 3, run OpenTofu here
docs/         one guide per path
```

The OpenTofu folders are a convenience, not a requirement. Each guide says what the AWS resources must look
like, so you can create them with your own tooling and skip OpenTofu entirely. Nothing in the Helm charts
reads OpenTofu state, and nothing in OpenTofu installs a chart.

## Before you start

The images are private on Docker Hub. Get an access token from Eka, then:

```bash
docker login -u ekacare
docker pull ekacare/ekascribe:api-latest          # vaarta itself, about 1 GB, amd64 and arm64
docker pull ekacare/parrotlet_a:v2.5b             # the speech model, about 24 GB, amd64 only
```

Pull the model image only if you intend to run it yourself. On Apple silicon add
`--platform linux/amd64` when the image is destined for an amd64 machine, and the other way round: an
architecture mismatch shows up much later as `exec format error` in a container log.

## Getting help

Each guide ends with the failures that actually happen on that path and what they mean. If something here is
wrong or missing, that is a bug in this folder, so please say so rather than working around it.
