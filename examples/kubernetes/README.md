# Running Smithers on Kubernetes

Deploy Smithers workflows as a distributed system on any Kubernetes cluster.
The orchestrator runs as a single pod (source of truth), workers scale
independently as a Deployment.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (for building images)
- [kubectl](https://kubernetes.io/docs/tasks/tools/) configured for your cluster
- [Bun](https://bun.sh) >= 1.3
- A Kubernetes cluster (see [Quick Start](#quick-start-minikube) for local dev)

## Quick Start (Minikube)

```bash
# Install minikube if you don't have it
# macOS: brew install minikube
# Linux: curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64

# Start a local cluster
minikube start --cpus=4 --memory=8192

# Build Smithers images and deploy
cd examples/kubernetes
bun install
bun run deploy

# Watch it run
kubectl logs -f deployment/smithers-orchestrator -n smithers-system

# Access the Gateway
minikube service smithers-gateway -n smithers-system --url
```

## Project Structure

```
examples/kubernetes/
├── README.md
├── package.json
├── workflow.tsx              # Example Smithers workflow
├── Dockerfile                # Multi-stage: orchestrator + worker
├── k8s/
│   ├── namespace.yaml        # smithers-system namespace
│   ├── postgres.yaml         # PostgreSQL StatefulSet + Service
│   ├── orchestrator.yaml     # Orchestrator Deployment + Service
│   ├── worker.yaml           # Worker Deployment + Service
│   ├── gateway.yaml          # Gateway Service (LoadBalancer)
│   └── secrets.yaml          # API keys (template — fill in your own)
└── scripts/
    ├── build.js              # Build Docker images
    ├── deploy.js             # Deploy to Kubernetes
    └── teardown.js           # Remove everything
```

## How It Works

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                             │
│                                                                  │
│  ┌─────────────────────┐     ┌────────────────────────────────┐ │
│  │   PostgreSQL         │     │   Orchestrator Pod             │ │
│  │   (StatefulSet)      │◄────│                                │ │
│  │                      │     │   React JSX → Plan Tree        │ │
│  │   Stores all state:  │     │   Scheduler → Task Dispatch    │ │
│  │   events, outputs,   │     │   @effect/cluster Sharding     │ │
│  │   approvals, etc.    │     │   Gateway (WS + HTTP)          │ │
│  └──────────────────────┘     └──────────┬─────────────────────┘ │
│                                          │ @effect/rpc            │
│                               ┌──────────┴──────────┐            │
│                               │                     │            │
│                    ┌──────────▼──────┐  ┌───────────▼─────┐     │
│                    │  Worker Pod 1   │  │  Worker Pod N   │     │
│                    │                 │  │                 │     │
│                    │  Receives tasks │  │  Receives tasks │     │
│                    │  Runs agents    │  │  Runs agents    │     │
│                    │  Returns JSON   │  │  Returns JSON   │     │
│                    │  + DiffBundle   │  │  + DiffBundle   │     │
│                    └─────────────────┘  └─────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

**Orchestrator pod** runs the React scheduler, builds plan trees, and dispatches
tasks to workers via `@effect/cluster` sharding. It connects to Postgres for all
state persistence and exposes the Gateway API for external clients.

**Worker pods** receive serialized tasks via `@effect/rpc` over HTTP. They
execute agents (Claude, OpenAI, Codex, etc.) and compute functions. Results are
returned as JSON output + DiffBundle (filesystem changes as unified patches).
Workers have no direct database access.

**PostgreSQL** stores all workflow state: events, task results, approvals,
signals, snapshots. It replaces SQLite for multi-process access in Kubernetes.

Workers are stateless from the orchestrator's perspective. Kill a worker pod and
the orchestrator re-dispatches its in-flight tasks to another worker
automatically.

## Writing Your Workflow

Your workflow code is identical to local Smithers — no changes needed:

```tsx
// workflow.tsx
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, Workflow, Task, Sequence, outputs } = createSmithers({
  analysis: z.object({
    summary: z.string(),
    findings: z.array(z.string()),
    score: z.number(),
  }),
  report: z.object({
    markdown: z.string(),
  }),
});

export default smithers((ctx) => (
  <Workflow name="distributed-analysis">
    <Sequence>
      <Task id="analyze" agent={myAgent} output={outputs.analysis}>
        Analyze the repository for code quality issues
      </Task>
      <Task id="report" agent={myAgent} output={outputs.report}>
        Write a markdown report based on the analysis:
        {JSON.stringify(ctx.output("analyze"))}
      </Task>
    </Sequence>
  </Workflow>
));
```

The orchestrator/worker split is handled entirely by configuration. Your
workflow runs identically locally (single process, SQLite) and on Kubernetes
(distributed, Postgres).

## Configuration

### Secrets

Edit `k8s/secrets.yaml` with your credentials before deploying:

| Variable | Required | Description |
|---|---|---|
| `pg-password` | Yes | PostgreSQL password |
| `ANTHROPIC_API_KEY` | If using Claude agents | Anthropic API key |
| `OPENAI_API_KEY` | If using OpenAI agents | OpenAI API key |

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SMITHERS_ROLE` | `standalone` | Process role: `orchestrator`, `worker`, or `standalone` |
| `SMITHERS_PG_HOST` | — | PostgreSQL host (required for orchestrator) |
| `SMITHERS_PG_PORT` | `5432` | PostgreSQL port |
| `SMITHERS_PG_DATABASE` | `smithers` | PostgreSQL database name |
| `SMITHERS_PG_USER` | `smithers` | PostgreSQL username |
| `SMITHERS_PG_PASSWORD` | — | PostgreSQL password |
| `SMITHERS_ORCHESTRATOR_URL` | — | Orchestrator cluster URL (required for workers) |

## Scaling Workers

```bash
# Manual scaling
kubectl scale deployment smithers-worker --replicas=10 -n smithers-system

# The worker Deployment includes HPA annotations for autoscaling.
# To enable, create a HorizontalPodAutoscaler targeting the
# smithers_pending_tasks Prometheus metric.
```

## Operations

### View workflow runs

```bash
# Via kubectl
kubectl logs deployment/smithers-orchestrator -n smithers-system

# Via Smithers CLI (pointing at the Gateway)
export SMITHERS_GATEWAY_URL=$(minikube service smithers-gateway -n smithers-system --url)
smithers list --gateway $SMITHERS_GATEWAY_URL
```

### Approve a task

```bash
smithers approve --run-id <run-id> --node-id <node-id> --gateway $SMITHERS_GATEWAY_URL
```

### Tear down

```bash
bun run teardown
# or: kubectl delete namespace smithers-system
```

## Deploying to Cloud Providers

The manifests work on any standard Kubernetes cluster. Swap `minikube` for your
provider:

```bash
# GKE
gcloud container clusters get-credentials my-cluster
bun run deploy

# EKS
aws eks update-kubeconfig --name my-cluster
bun run deploy

# Any cluster with kubectl configured
bun run deploy
```

For production, replace the bundled PostgreSQL StatefulSet with a managed
database service (Cloud SQL, RDS, etc.) and update `k8s/secrets.yaml`
accordingly.

## Alternative: Fabrik (K3s-based)

[Fabrik](https://github.com/SamuelLHuber/local-isolated-ralph) by
[Samuel Huber](https://github.com/SamuelLHuber) (dTech.vision) is a K3s-based
Kubernetes layer for Smithers that takes a fundamentally different architectural
approach. It uses `smithers-orchestrator` as a direct dependency and wraps it
with Kubernetes-native job dispatch.

**Key differences:**

| | This Example | Fabrik |
|---|---|---|
| Kubernetes | Standard K8s (any provider) | K3s (lightweight, single binary) |
| State storage | Shared PostgreSQL | Per-run SQLite on PVCs (10GB each) |
| Workers | Long-lived Deployment pods | Kubernetes Jobs per run |
| CLI | Bun (same as Smithers) | Go binary (`fabrik`) |
| Infrastructure | Pure K8s manifests | Terraform + NixOS on Hetzner |
| Local dev | Minikube | K3d (K3s-in-Docker) |
| Task dispatch | @effect/cluster sharding | K8s Job creation via API |
| Image builds | Docker multi-stage | Nix (reproducible, multi-arch) |
| Status tracking | Gateway API + Postgres | K8s pod annotations |
| Security | Network policies (planned) | Network policies + Pod Security Standards |

**Consider Fabrik if you want:**
- Lighter resource footprint (K3s single binary vs full K8s)
- Full isolation between workflow runs (each run gets its own SQLite + PVC)
- Terraform-managed infrastructure on Hetzner Cloud
- A Go CLI for Kubernetes-native job dispatch
- Nix-built reproducible container images
- Strong security hardening out of the box (runs can't reach control plane or
  each other, restricted Pod Security Standards, read-only root filesystem)
- Immutable image digests for crash recovery (resume uses exact same image)

**Consider this example if you want:**
- Standard Kubernetes that works on any cloud provider
- Shared Postgres for cross-run queries, dashboards, and observability
- The official Smithers worker model with `@effect/cluster` sharding
- Long-lived workers with autoscaling based on task queue depth
- Simpler setup (no Terraform, NixOS, or Hetzner dependency)
