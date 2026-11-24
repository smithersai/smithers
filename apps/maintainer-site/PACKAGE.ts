/**
 * Targets for the maintainer site: its unit suites.
 *
 * The suites drive the decision queue's server over a real loopback socket,
 * the Markdown renderer and the outline parser, and replay a recorded slice
 * through `jj` history. This target runs every headless Node unit suite in CI (matching package.json "test"); browser queue tests run under "test:queue".
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"
import { Package as mvpPackage } from "../mvp/PACKAGE.ts"

const cwd = "apps/maintainer-site"

/** The server, its renderers, the browser client and the fixtures the suites copy. */
const sources = [
  Smithers.glob("//apps/maintainer-site/*.mjs", { exclude: ["**/*.test.mjs"] }),
  Smithers.glob("//apps/maintainer-site/client/**/*"),
  Smithers.glob("//apps/maintainer-site/test/fixtures/**/*"),
  Smithers.file("//apps/maintainer-site/package.json"),
  Smithers.file("//apps/maintainer-site/markdown.test.mjs"),
  Smithers.file("//apps/maintainer-site/test/build.test.mjs"),
  Smithers.file("//apps/maintainer-site/test/serve.test.mjs"),
  Smithers.file("//apps/maintainer-site/test/outline.test.mjs"),
  Smithers.file("//apps/maintainer-site/test/revision.test.mjs"),
  Smithers.file("//apps/maintainer-site/test/work-metadata.test.mjs")
]

/**
 * The server, Markdown, outline, work-metadata and recorded-revision suites. The revision
 * suite needs the `jj` binary.
 *
 * @since 1.0.0
 * @category test
 */
const test = Smithers.NodeTest({
  runner: Smithers.testSuite([
    "markdown.test.mjs",
    "test/build.test.mjs",
    "test/serve.test.mjs",
    "test/outline.test.mjs",
    "test/revision.test.mjs",
    "test/work-metadata.test.mjs"
  ]),
  srcs: sources,
  deps: [mvpPackage.workNotes],
  cwd
})

const bench = Smithers.NodeBench({
  entry: Smithers.file("bench/run.mjs"),
  srcs: [...sources, Smithers.file("bench/run.mjs")],
  deps: [],
  cache: true,
  cwd
})

export const Package = Smithers.Package({
  targets: { bench, test }
})
