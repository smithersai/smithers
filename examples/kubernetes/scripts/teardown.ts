import { $ } from "bun";

console.log("Removing smithers-system namespace and all resources...");
await $`kubectl delete namespace smithers-system --ignore-not-found`;
console.log("Done. All Smithers resources removed from cluster.");
