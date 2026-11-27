/**
 * The packages a release publishes, by npm name. The release packs and
 * publishes exactly these, and npm-dist-tag.yml moves a dist-tag only for one
 * of them. The module imports nothing, so a job with no dependencies installed
 * can read it.
 */
/**
 * The package names published by the current release candidate.
 *
 * Group membership alone would let a new or newly public package join the
 * release by declaring a group, and it would let a package leave by flipping
 * `private`. Both are release decisions, so the roster is restated here and
 * checked against what the workspace actually declares.
 */
export const publishedPackages = [
  "@smthrs/agent",
  "@smthrs/app-core",
  "@smthrs/artifacts",
  "@smthrs/build",
  "@smthrs/build-cli",
  "@smthrs/canonical",
  "@smthrs/capability",
  "@smthrs/cli",
  "@smthrs/control",
  "@smthrs/core",
  "@smthrs/crypto",
  "@smthrs/database",
  "@smthrs/engine",
  "@smthrs/engine-store",
  "@smthrs/errors",
  "@smthrs/evals",
  "@smthrs/flow",
  "@smthrs/flows",
  "@smthrs/fuzz",
  "@smthrs/gateway",
  "@smthrs/harness",
  "@smthrs/integrations",
  "@smthrs/jj",
  "@smthrs/journal",
  "@smthrs/kernel",
  "@smthrs/keys",
  "@smthrs/mcp",
  "@smthrs/memory",
  "@smthrs/migrate",
  "@smthrs/model",
  "@smthrs/notifications",
  "@smthrs/observability",
  "@smthrs/patterns",
  "@smthrs/plan",
  "@smthrs/plan-store",
  "@smthrs/platform-browser",
  "@smthrs/platform-bun",
  "@smthrs/platform-cloudflare",
  "@smthrs/platform-node",
  "@smthrs/plugin",
  "@smthrs/registry",
  "@smthrs/run-store",
  "@smthrs/sandbox",
  "@smthrs/scorers",
  "@smthrs/std",
  "@smthrs/step-cache",
  "@smthrs/sync",
  "@smthrs/targets",
  "@smthrs/testing",
  "@smthrs/time-travel",
  "@smthrs/triggers",
  "@smthrs/views",
  "smithers-ci",
  "smthrs"
]
