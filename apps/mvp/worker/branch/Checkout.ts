import type { CodeStorage } from "@smthrs/effect-code-storage"
import { FORGE_HOST, WORKSPACE } from "../../src/features/terminal/contract.ts"

// How a branch's machine checks the branch out (decision 0013 §2, `terminal/Open` step 2): a clone of the one
// branch into /workspace, through the forge proxy, whose remote names no credential. A machine that has a checkout
// keeps it. An unresolved HEAD never authorizes deleting files; clone refuses a nonempty workspace.

/** Ordinary namespace checkout depth: enough for `git log`, cheap to read from the forge. */
export const DEPTH = 50

/** The git remote the box clones from: the forge proxy's own host, which the box can't leave. */
export const forgeRemote = (owner: string, name: string): string =>
  `http://${FORGE_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

/**
 * Why a checkout failed, by its exit code, so a failure says where it broke without its output: the forge didn't
 * answer the ref list (`forge`), it answered without the branch (`branch`), or the clone itself failed (`clone`).
 */
export const CHECKOUT_FAILURES: Readonly<Record<number, "forge" | "branch" | "clone">> = { 70: "forge", 71: "branch", 72: "clone" }

const script = (namespace: CodeStorage.RefNamespace) => [
  "set -e",
  // Files the clone writes are the `workspace` group's to change too: every person's shell shares the checkout.
  "umask 002",
  // A CI job's machine names a commit, not a branch: it fetches that one commit by its id and checks it out detached,
  // since a pull request's head from a fork is no branch of the repository. Its image may hold another commit's
  // checkout as a base (infra/gate/Dockerfile): only the commit itself counts as checked out, and the fetch brings
  // what the commit adds to it.
  `if printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; then`,
  `  [ "$(git -C ${WORKSPACE} rev-parse --verify -q HEAD 2>/dev/null)" = "$1" ] && exit 0`,
  // A machine stopped mid-checkout left the repository and its origin: set it again, never fail on it.
  `  git init --quiet ${WORKSPACE} || exit 72`,
  `  git -C ${WORKSPACE} remote set-url origin "$2" 2>/dev/null || git -C ${WORKSPACE} remote add origin "$2" || exit 72`,
  `  git -C ${WORKSPACE} fetch --quiet --depth 1 origin "$1" || exit 72`,
  `  exec git -C ${WORKSPACE} -c advice.detachedHead=false checkout --quiet --force --detach FETCH_HEAD`,
  "fi",
  `if git -C ${WORKSPACE} rev-parse --verify -q HEAD >/dev/null 2>&1; then exit 0; fi`,
  `refs=$(git ls-remote --heads "$2" 2>/dev/null) || exit 70`,
  `printf '%s\\n' "$refs" | awk -v ref="refs/heads/$1" '$2 == ref { found = 1 } END { exit !found }' || exit 71`,
  `git clone --quiet ${namespace === "ephemeral" ? "" : `--depth ${DEPTH} `}--branch "$1" --single-branch "$2" ${WORKSPACE} || exit 72`,
].join("\n")

/**
 * The command that checks branch `branch` of `remote` out in /workspace unless it is there; `branch` may instead be a
 * commit's 40-hex id, which a CI job's machine checks out alone and detached. The branch and the remote travel as
 * arguments, never inside the script, so no name can change what runs.
 * Ephemeral refs use full history because their scoped proxy disallows shallow negotiation.
 */
export const checkoutArgv = (branch: string, remote: string, namespace: CodeStorage.RefNamespace = "default"): Array<string> =>
  ["sh", "-c", script(namespace), "checkout", branch, remote]
