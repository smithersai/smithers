---
"@smthrs/targets": minor
"@smthrs/build-cli": minor
---

`S.nodeModules(directory)` declares an installed dependency tree as a target input. The planner keys the directory's `package.json` and every lockfile beside it, and under an enforced sandbox the tool may read that directory's `node_modules` and nothing else in it. A tool that resolves modules from a directory that is not above its own working directory can now run confined, so its result can be published to the shared cache. A directory with no manifest or no lockfile fails planning; a tree linked to anything but an installed `node_modules` fails the target closed. `smthrs affected` selects the target when the manifest or a lockfile changes.
