/**
 * Checks a request of `npm-dist-tag.yml` before it reads or writes the
 * registry: the package is one a release publishes, the version is exact, and
 * the tag is a lowercase word. A refused request prints one GitHub error line
 * and exits 1.
 *
 * The package list is the release's own (`published-packages.mjs`), so a
 * package the release publishes, such as `smithers-ci`, can have its tag moved,
 * and a name it does not publish, such as `smithers-orchestrator`, cannot.
 *
 * usage: PACKAGE=<name> VERSION=<version> TAG=<tag> node .smithers/flows/release/dist-tag-request.mjs
 */
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { publishedPackages } from "./published-packages.mjs"

/** Why a request is refused, or undefined when it may go ahead. */
export const refusal = ({ name, version, tag }) =>
  !publishedPackages.includes(name)
    ? `package must be one a release publishes (.smithers/flows/release/published-packages.mjs); got '${name}'.`
    : !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)
    ? `version must be an exact version such as 1.0.0-rc.8; got '${version}'.`
    : !/^[a-z][a-z0-9-]{0,63}$/.test(tag)
    ? `tag must be a lowercase word such as latest or next; got '${tag}'.`
    : undefined

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reason = refusal({ name: process.env.PACKAGE ?? "", version: process.env.VERSION ?? "", tag: process.env.TAG ?? "" })
  if (reason !== undefined) {
    console.log(`::error::${reason}`)
    process.exitCode = 1
  }
}
