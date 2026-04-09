import { $ } from "bun";

const target =
  process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ??
  "minikube";

async function deploy() {
  switch (target) {
    case "minikube": {
      // Check minikube is running
      try {
        const status = await $`minikube status`.text();
        if (!status.includes("Running")) throw new Error("not running");
      } catch {
        console.log("Starting minikube...");
        await $`minikube start --cpus=4 --memory=8192`;
      }

      // Build images
      console.log("Building Docker images...");
      await $`bun run scripts/build.ts`;

      // Load into minikube
      console.log("Loading images into minikube...");
      await $`minikube image load smithers-orchestrator:latest`;
      await $`minikube image load smithers-worker:latest`;

      // Apply manifests in order
      console.log("Applying Kubernetes manifests...");
      await $`kubectl apply -f k8s/namespace.yaml`;
      await $`kubectl apply -f k8s/secrets.yaml`;
      await $`kubectl apply -f k8s/postgres.yaml`;

      console.log("Waiting for PostgreSQL...");
      await $`kubectl wait --for=condition=ready pod -l app=smithers-postgres -n smithers-system --timeout=120s`;

      await $`kubectl apply -f k8s/orchestrator.yaml`;
      await $`kubectl apply -f k8s/worker.yaml`;
      await $`kubectl apply -f k8s/gateway.yaml`;

      console.log("Waiting for orchestrator...");
      await $`kubectl wait --for=condition=ready pod -l app=smithers-orchestrator -n smithers-system --timeout=120s`;

      const url =
        await $`minikube service smithers-gateway -n smithers-system --url`.text();
      console.log(`\nDeployed! Gateway available at: ${url.trim()}`);
      console.log(
        `\nRun a workflow:\n  smithers run workflow.tsx --gateway ${url.trim()}`,
      );
      break;
    }

    default: {
      // Generic kubectl deploy (assumes kubectl is configured)
      console.log(`Deploying to current kubectl context...`);
      await $`kubectl apply -f k8s/namespace.yaml`;
      await $`kubectl apply -f k8s/secrets.yaml`;
      await $`kubectl apply -f k8s/postgres.yaml`;

      console.log("Waiting for PostgreSQL...");
      await $`kubectl wait --for=condition=ready pod -l app=smithers-postgres -n smithers-system --timeout=120s`;

      await $`kubectl apply -f k8s/orchestrator.yaml`;
      await $`kubectl apply -f k8s/worker.yaml`;
      await $`kubectl apply -f k8s/gateway.yaml`;

      console.log("Waiting for orchestrator...");
      await $`kubectl wait --for=condition=ready pod -l app=smithers-orchestrator -n smithers-system --timeout=120s`;

      console.log("\nDeployed! Check status with:");
      console.log(
        "  kubectl get pods -n smithers-system",
      );
      break;
    }
  }
}

deploy().catch((err) => {
  console.error("Deploy failed:", err.message);
  process.exit(1);
});
