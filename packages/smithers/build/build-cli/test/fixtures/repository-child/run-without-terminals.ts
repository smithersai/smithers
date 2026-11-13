/**
 * Runs one target as a repository child that was handed no terminals, the
 * way a library caller inside `Repo.Target` would: the live view must reach
 * this process's own pipes.
 */
import * as PackageDiscovery from "../../../src/PackageDiscovery.ts"
import * as PackageExec from "../../../src/PackageExec.ts"
import { PackageIndex } from "../../../src/PackageIndex.ts"
import * as PackageLoader from "../../../src/PackageLoader.ts"

const root = process.argv[2]!
const summary = await PackageExec.run({
  index: PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root),
  cacheDirectory: ".flows",
  verb: "auto",
  patterns: ["//:good"],
  readCache: false,
  environment: { ...process.env, SMTHRS_REPO_CHILD: "1" }
})
process.exitCode = summary.ok ? 0 : 1
