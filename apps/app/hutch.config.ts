/*
 * Hutch (Electrobun 2.x build CLI) project settings. The workspace installs
 * with pnpm, so Hutch delegates to it instead of its built-in resolver and
 * reads the pnpm node_modules that already exists. The Electrobun release
 * comes from the `electrobun` dependency in package.json; no pin here.
 */
export default {
  packageManager: "pnpm"
}
