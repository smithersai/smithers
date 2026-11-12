/**
 * Targets for the maintainer site: its unit suites.
 *
 * The suites drive the decision queue's server over a real loopback socket,
 * the Markdown renderer and the outline parser, and replay a recorded slice
 * through `jj` history. This target runs every unit suite in CI, including the queue review suite.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/maintainer-site"

/** The server, its renderers, the browser client and the fixtures the suites copy. */
const sources = [
  Smithers.glob("//apps/maintainer-site/*.mjs", { exclude: ["**/*.test.mjs"] }),
  Smithers.glob("//apps/maintainer-site/client/**/*"),
  Smithers.glob("//apps/maintainer-site/test/fixtures/**/*"),
  Smithers.file("//apps/maintainer-site/package.json"),
  Smithers.file("//apps/maintainer-site/markdown.test.mjs"),
  Smithers.glob("//apps/maintainer-site/test/*.test.mjs")
]

/**
 * The server, Markdown, outline, queue review and recorded-revision suites. The revision
 * suite needs the `jj` binary.
 *
 * @since 1.0.0
 * @category test
 */
const test = Smithers.NodeTest({
  runner: Smithers.testSuite(["markdown.test.mjs", "test/*.test.mjs"]),
  srcs: sources,
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { test }
})
