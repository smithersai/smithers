/** Bounded subprocess capture for disposable installed-package release probes. */
import { spawn } from "node:child_process"

const posix = process.platform !== "win32"

// What a disposable consumer needs to find its toolchain, reach the registry
// and run the native helper under test. Names compare upper-cased: Windows
// spells `Path`, and proxies are conventionally lower-case.
const consumerNames = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "TERM", "LANG", "TZ", "CI",
  "PNPM_HOME", "BUN_INSTALL", "NODE_OPTIONS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "SMITHERS_NATIVE_HELPERS_DIR", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "SMITHERS_JJ_PATH"
])
const consumerPrefixes = ["LC_", "XDG_", "COREPACK_", "NPM_CONFIG_", "PNPM_CONFIG_"]
// A kept prefix still never carries a credential or a file of them: npm reads
// `npm_config_//host/:_authToken`, and `NPM_CONFIG_USERCONFIG` names the
// .npmrc that setup-node fills with `${NODE_AUTH_TOKEN}`.
const credentialName = /TOKEN|AUTH|PASSWORD|PASSWD|SECRET|CREDENTIAL|USERCONFIG|(?:^|_)KEY(?:$|_)/i

/**
 * The environment of every release consumer: installs, build scripts, imports,
 * compilers and CLI probes run downloaded code, so they get an allowlist of the
 * caller's environment and never its cache, registry or GitHub credentials.
 * Applying it twice changes nothing.
 */
export const consumerEnv = (env = process.env) =>
  Object.fromEntries(
    Object.entries(env).filter(([name, value]) => {
      const upper = name.toUpperCase()
      return value !== undefined && !credentialName.test(name) &&
        (consumerNames.has(upper) || consumerPrefixes.some((prefix) => upper.startsWith(prefix)))
    })
  )

/**
 * `text` with every credential the caller holds, and the password of any URL,
 * replaced by a marker. A consumer never receives these values, but one can
 * still read them from a file and print them into the release log.
 */
export const redactCredentials = (text, env = process.env) => {
  let redacted = text
  for (const [name, value] of Object.entries(env)) {
    if (credentialName.test(name) && typeof value === "string" && value.length >= 8) {
      redacted = redacted.split(value).join(`[redacted ${name}]`)
    }
  }
  return redacted.replace(/(\/\/[^\s/:@]+):[^\s/@]+@/g, "$1:[redacted]@")
}

/**
 * Runs one owned process group until stdout and stderr close, a deadline
 * expires, or the caller stops it. Every settlement kills the whole group and
 * destroys both pipes, so a descendant that inherited the output pipes can
 * neither keep the caller waiting nor outlive the probe.
 *
 * `onOutput(chunk, source, stop)` receives each stdout/stderr chunk until settlement.
 * Resolves `{ failure, code, signal }`; `failure` is set when the deadline
 * expired, the caller stopped the run, or the process could not start.
 */
export const superviseProcess = (command, args, { cwd, env = process.env, timeoutMs, timeoutMessage = `Command timed out after ${timeoutMs} ms before its output closed`, onOutput = () => {} }) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: posix })
    } catch (error) {
      resolve({ failure: error, code: null, signal: null })
      return
    }
    let failure
    let settled = false
    const settle = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (child.pid !== undefined) {
        try {
          if (posix) process.kill(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch (error) {
          if (error.code !== "ESRCH") failure ??= error
        }
      }
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ failure, code, signal })
    }
    const stop = (error) => {
      failure ??= error
      settle(null, null)
    }
    const deadline = setTimeout(() => stop(new Error(timeoutMessage)), timeoutMs)
    for (const source of ["stdout", "stderr"]) child[source].on("data", (chunk) => { if (!settled) onOutput(chunk, source, stop) })
    child.once("error", stop)
    child.once("close", settle)
  })

/**
 * Waits for stdout/stderr to close, not just for the child to exit. A broken
 * import must not hang the release gate or buffer unlimited diagnostic output,
 * and output held open past the deadline by a descendant is a failed probe.
 */
export const captureProcess = async (command, args, cwd, { timeoutMs = 120_000, maxOutputBytes = 1024 * 1024, env = process.env } = {}) => {
  const chunks = { stdout: [], stderr: [] }
  let bytes = 0
  const { failure, code, signal } = await superviseProcess(command, args, {
    cwd,
    env,
    timeoutMs,
    onOutput: (chunk, source, stop) => {
      if (bytes + chunk.length > maxOutputBytes) {
        chunks[source].push(chunk.subarray(0, maxOutputBytes - bytes))
        bytes = maxOutputBytes
        stop(new Error(`Command output exceeds its ${maxOutputBytes}-byte limit`))
        return
      }
      bytes += chunk.length
      chunks[source].push(chunk)
    }
  })
  const output = redactCredentials(Buffer.concat([...chunks.stdout, ...chunks.stderr]).toString("utf8"))
  const error = failure?.message
    ?? (code === 0 ? undefined : `Command failed: ${[command, ...args].join(" ")} ${signal === null ? `exited with ${code}` : `was killed by ${signal}`}`)
  return error === undefined ? { ok: true, output } : { ok: false, output: `${output}\n${error}` }
}
