import { $ } from "bun";

const tag = process.env.IMAGE_TAG ?? "latest";

console.log(`Building smithers-orchestrator:${tag}...`);
await $`docker build --target orchestrator -t smithers-orchestrator:${tag} .`;

console.log(`Building smithers-worker:${tag}...`);
await $`docker build --target worker -t smithers-worker:${tag} .`;

console.log(`Done. Built smithers-orchestrator:${tag} and smithers-worker:${tag}`);
