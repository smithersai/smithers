import type { CodeStorage } from "@smthrs/effect-code-storage"
import type { CiJob } from "@smthrs/sandbox"
import { pinnedCheckoutExit } from "../../src/features/runs/checkoutStage.ts"
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
 * answer the ref list (`forge`), it answered without the branch (`branch`), or cloning the branch failed (`clone`). Pinned jobs distinguish initialization, remote configuration, fetch
 * and writing the working copy. Older pinned receipts used 72 for any of the first three commands.
 */
export const CHECKOUT_FAILURES: Readonly<Record<number, "forge" | "branch" | "clone">> = {
  70: "forge", 71: "branch", 72: "clone", [pinnedCheckoutExit.init]: "clone", [pinnedCheckoutExit.remote]: "clone",
  [pinnedCheckoutExit.fetch]: "clone", [pinnedCheckoutExit.worktree]: "clone",
}

/** Bounded machine-side transport diagnostics derived from checkout exit and stderr. Never contains stderr text. */
export interface CheckoutTransportDiagnostics {
  readonly checkoutTransportCause?: CiJob.CheckoutTransportCause
  readonly checkoutHttpStatus?: CiJob.CheckoutHttpStatus
}

const HTTP_STATUS_PATTERNS: ReadonlyArray<RegExp> = [
  /\bThe requested URL returned error:\s*([1-5]\d{2})\b/i,
  /\bRPC failed;\s*HTTP\s+([1-5]\d{2})\b/i,
  /\breturned error:\s*([1-5]\d{2})\b/i,
  /\bstatus code\s+([1-5]\d{2})\b/i,
  /\bHTTP(?:\/[123](?:\.[01])?)?\s+([45]\d{2})\b/,
]

const LOCAL_STORAGE_PATTERN = /\b(?:No space left on device|Disk quota exceeded|Read-only file system|Permission denied|Operation not permitted|Input\/output error|Unable to create|cannot lock ref|cannot mkdir|already exists and is not an empty directory|insufficient permission|failed to write|unable to write)\b/i
const HTTP_NOT_FOUND_PATTERN = /\bfatal:\s+repository\s+'https?:\/\/[^'\r\n]+'\s+not found\b/i
const HTTP_AUTH_PATTERN = /\b(?:Authentication failed for|could not read (?:Username|Password) for)\s+'https?:\/\/[^'\r\n]+'/i
const HTTP_OTHER_PATTERN = /\b(?:unable to update url base from redirection|curl\s+22)\b/i
const DNS_PATTERN = /\b(?:Could not resolve host|Could not resolve proxy|Resolving timed out|Name or service not known|Temporary failure in name resolution|nodename nor servname provided|No address associated with hostname|getaddrinfo|curl\s+[56])\b/i
const MISSING_OBJECT_PATTERN = /\b(?:Server does not allow request for unadvertised object|upload-pack:\s*not our ref|not our ref\b|couldn't find remote ref|Remote branch\b[^\r\n]*\bnot found|no such ref was fetched|does not have commit|not a valid object name|fatal:\s+bad object\b|want\s+[0-9a-f]{40}\s+not valid)\b/i
const SIGNAL_SENTINEL_PATTERN = /\bsmithers-checkout-signal:(?:129|1[3-9]\d|2[0-4]\d|25[0-5])\b/
const INTERRUPTED_PATTERN = /\b(?:died of signal|unexpected disconnect|the remote end hung up unexpectedly|early EOF|Connection reset by peer|Connection timed out|Operation timed out|Failed to connect|Could not connect|Connection refused|Empty reply from server|transfer closed|Recv failure|Send failure|Broken pipe|HTTP\/[23] stream \d+ was not closed cleanly|SSL_|GnuTLS|TLS\b|timed out|Network is unreachable|No route to host|Software caused connection abort|curl\s+(?:7|18|28|35|52|55|56))\b/i
const KILLED_PATTERN = /(?:^|[:\s])(?:Killed|Terminated)(?:\s|$)/
const PACK_PATTERN = /\b(?:index-pack failed|unpack-objects failed|invalid index-pack output|bad pack|pack has bad object|packfile|corrupt|inflate returned|zlib|non-monotonic index|did not send all necessary objects|unable to unpack|SHA1 collision|pack-objects died|unable to read tree)\b/i

const httpStatusOf = (text: string): CiJob.CheckoutHttpStatus | undefined => {
  for (const pattern of HTTP_STATUS_PATTERNS) {
    const match = pattern.exec(text)
    if (match === null) continue
    const code = Number.parseInt(match[1]!, 10)
    if (Number.isInteger(code) && code >= 100 && code <= 599) return code
  }
  return undefined
}

/**
 * Classifies a failed checkout's machine-side transport cause from its exit code and bounded stderr, stripping
 * untrusted `remote:` sideband lines first. Returns only closed enum values (plus a bounded 100–599 HTTP status when
 * observed), never raw stderr, URLs, paths, or secrets. Returns `{}` for branch-absent exit 71 (where ref listing
 * succeeded) and `{ checkoutTransportCause: "unknown" }` for any other unclassified failure so live failures stay
 * distinct from historical receipts that omit the field.
 */
export const classifyCheckoutTransport = (exitCode: number, stderr: string): CheckoutTransportDiagnostics => {
  if (exitCode === 71) return {}
  // Ignore remote sideband banners so untrusted repository output cannot spoof local transport classification.
  const local = stderr
    .split(/\r?\n/)
    .filter((line) => !/^\s*remote:\s/i.test(line))
    .join("\n")

  if (LOCAL_STORAGE_PATTERN.test(local)) return { checkoutTransportCause: "pack_storage" }

  const status = httpStatusOf(local)
  if (status !== undefined) return { checkoutTransportCause: "http_status", checkoutHttpStatus: status }
  if (HTTP_NOT_FOUND_PATTERN.test(local)) return { checkoutTransportCause: "http_status", checkoutHttpStatus: 404 }
  if (HTTP_AUTH_PATTERN.test(local)) return { checkoutTransportCause: "http_status", checkoutHttpStatus: 401 }
  if (HTTP_OTHER_PATTERN.test(local)) return { checkoutTransportCause: "http_status" }

  if (DNS_PATTERN.test(local)) return { checkoutTransportCause: "dns" }
  if (MISSING_OBJECT_PATTERN.test(local)) return { checkoutTransportCause: "missing_object" }
  if (exitCode > 128 || SIGNAL_SENTINEL_PATTERN.test(local) || INTERRUPTED_PATTERN.test(local) || KILLED_PATTERN.test(local)) {
    return { checkoutTransportCause: "interrupted" }
  }
  if (PACK_PATTERN.test(local)) return { checkoutTransportCause: "pack_storage" }

  return { checkoutTransportCause: "unknown" }
}

const script = (namespace: CodeStorage.RefNamespace) => [
  "set -e",
  // Files the clone writes are the `workspace` group's to change too: every person's shell shares the checkout.
  "umask 002",
  // Preserve signal termination (>128) on stderr without changing the checkout stage's exit code.
  `fail() { rc=$1; code=$2; if [ "$rc" -gt 128 ]; then printf 'smithers-checkout-signal:%s\\n' "$rc" >&2 || true; fi; exit "$code"; }`,
  // A CI job's machine names a commit, not a branch: it fetches that one commit by its id and checks it out detached,
  // since a pull request's head from a fork is no branch of the repository. Its image may hold another commit's
  // checkout as a base (infra/gate/Dockerfile): only the commit itself counts as checked out, and the fetch brings
  // what the commit adds to it.
  `if printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; then`,
  `  [ "$(git -C ${WORKSPACE} rev-parse --verify -q HEAD 2>/dev/null)" = "$1" ] && exit 0`,
  // A machine stopped mid-checkout left the repository and its origin: set it again, never fail on it.
  `  git init --quiet ${WORKSPACE} || fail $? ${pinnedCheckoutExit.init}`,
  `  git -C ${WORKSPACE} remote set-url origin "$2" 2>/dev/null || git -C ${WORKSPACE} remote add origin "$2" || fail $? ${pinnedCheckoutExit.remote}`,
  `  git -C ${WORKSPACE} fetch --quiet --depth 1 origin "$1" || fail $? ${pinnedCheckoutExit.fetch}`,
  `  git -C ${WORKSPACE} -c advice.detachedHead=false checkout --quiet --force --detach FETCH_HEAD || fail $? ${pinnedCheckoutExit.worktree}`,
  "  exit 0",
  "fi",
  `if git -C ${WORKSPACE} rev-parse --verify -q HEAD >/dev/null 2>&1; then exit 0; fi`,
  `refs=$(git ls-remote --heads "$2") || fail $? 70`,
  `printf '%s\\n' "$refs" | awk -v ref="refs/heads/$1" '$2 == ref { found = 1 } END { exit !found }' || exit 71`,
  `git clone --quiet ${namespace === "ephemeral" ? "" : `--depth ${DEPTH} `}--branch "$1" --single-branch "$2" ${WORKSPACE} || fail $? 72`,
].join("\n")

/**
 * The command that checks branch `branch` of `remote` out in /workspace unless it is there; `branch` may instead be a
 * commit's 40-hex id, which a CI job's machine checks out alone and detached. The branch and the remote travel as
 * arguments, never inside the script, so no name can change what runs.
 * Ephemeral refs use full history because their scoped proxy disallows shallow negotiation.
 */
export const checkoutArgv = (branch: string, remote: string, namespace: CodeStorage.RefNamespace = "default"): Array<string> =>
  ["sh", "-c", script(namespace), "checkout", branch, remote]
