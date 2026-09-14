/** Force pnpm's local package copier, even when the workspace defines deploy. */
export const packagedBuildRuntimeCommand = (destination: string): Array<string> => [
  "pnpm",
  // pnpm 11 permits scripts to override built-ins. `pm` must be the first
  // argument: without it a workspace deploy script can publish the website.
  "pm",
  "--config.inject-workspace-packages=true",
  "--config.node-linker=hoisted",
  "--filter",
  "@smthrs/build-cli",
  "deploy",
  "--prod",
  "--ignore-scripts",
  destination
]
