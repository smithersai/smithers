/**
 * Placeholder minting and outbound substitution for declared secrets.
 *
 * `Secret.ts` declares which environment variable holds a value. This module
 * is the execution half: it mints the placeholder a target actually receives,
 * and it replaces that placeholder with the real value on the way out.
 *
 * Two substitution seams exist, and they cover different things.
 *
 * 1. **Request-scoped.** {@link Vault.request} opens an exact-origin boundary.
 *    It resolves each authorized placeholder once while constructing that
 *    request and replaces an exact value echoed in the response.
 * 2. **Child request fields.** {@link startProxy} runs a local HTTP proxy a
 *    spawned tool is pointed at. Plain-HTTP request headers and bodies are
 *    rewritten. HTTPS `CONNECT` streams remain opaque because the boundary
 *    does not terminate TLS, so a vault holding placeholders refuses them
 *    before any connection reaches the destination.
 * 3. **Secret destination URLs.** {@link Proxy.urlFor} gives a child a
 *    loopback capability URL. The proxy resolves the real HTTP or HTTPS URL
 *    only when the child calls that capability, then performs the outbound
 *    request itself. The true destination never enters child argv or env, and
 *    the boundary is seeded with the resolved URL, its origin, and its request
 *    target, so an upstream that echoes any of them back gets the capability
 *    URL rewritten over it before the child sees the response.
 *
 * The value is read from the host environment at substitution time and kept
 * only in the request-local boundary, never in the durable vault. A run that
 * plans without executing, or never reaches an authorized request, never
 * reads the variable at all.
 *
 * @since 0.1.0
 */
import { randomBytes } from "node:crypto"
import * as NodeHttp from "node:http"
import * as NodeHttps from "node:https"
import * as NodeNet from "node:net"
import * as NodeUtil from "node:util/types"
import * as Secret from "./Secret.ts"
import { placeholderPattern, placeholderPrefix } from "./Secret.ts"

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Raised when a declared secret has no value on this host.
 *
 * Failing is the only safe answer. Substituting nothing would send the
 * placeholder itself to a remote service, which reads as a malformed
 * credential at best and is recorded in someone else's logs at worst.
 *
 * @category errors
 * @since 0.1.0
 */
export class SecretUnavailable extends Error {
  /** The environment variable that carries no value. */
  readonly env: string
  constructor(env: string) {
    super(`the declared secret ${env} is not set on this host`)
    this.name = "SecretUnavailable"
    this.env = env
  }
}

/**
 * Raised before egress when a placeholder is used for the wrong origin.
 * @category errors
 * @since 0.1.0
 */
export class SecretAudienceDenied extends Error {
  /** The environment name identifying the declaration, never its value. */
  readonly env: string
  /** The normalized origin the request attempted to reach. */
  readonly audience: string
  constructor(env: string, audience: string) {
    super(`the declared secret ${env} is not authorized for ${audience}`)
    this.name = "SecretAudienceDenied"
    this.env = env
    this.audience = audience
  }
}

/**
 * Raised when a host value cannot safely cross an HTTP request boundary.
 * @category errors
 * @since 0.1.0
 */
export class SecretValueInvalid extends Error {
  /** The environment name identifying the declaration, never its value. */
  readonly env: string
  constructor(env: string) {
    super(`the declared secret ${env} is not bounded control-free text`)
    this.name = "SecretValueInvalid"
    this.env = env
  }
}

/**
 * Parses and validates an HTTP CONNECT authority.
 *
 * @category parsing
 * @since 0.1.0
 */
export const parseConnectAuthority = (
  authority: string
): { readonly host: string; readonly port: number } | undefined => {
  let host: string
  let rawPort: string
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]")
    if (close <= 1 || authority[close + 1] !== ":" || NodeNet.isIP(authority.slice(1, close)) !== 6) {
      return undefined
    }
    host = authority.slice(1, close)
    rawPort = authority.slice(close + 2)
  } else {
    const separator = authority.lastIndexOf(":")
    if (separator <= 0 || authority.indexOf(":") !== separator) return undefined
    host = authority.slice(0, separator)
    rawPort = authority.slice(separator + 1)
  }
  if (/[/\\\s\u0000-\u001f\u007f]/.test(host) || !/^\d+$/.test(rawPort)) return undefined
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? { host, port } : undefined
}

/**
 * Reads one host environment variable.
 *
 * @category models
 * @since 0.1.0
 */
export type Read = (name: string) => string | undefined

/**
 * Maximum UTF-8 bytes accepted for one resolved credential.
 * @category constants
 * @since 0.1.0
 */
export const maximumSecretValueBytes = 16 * 1024

/**
 * Request-scoped substitution and reverse-redaction state.
 * @category models
 * @since 0.1.0
 */
export interface RequestBoundary {
  /** Replaces authorized placeholders, resolving each declaration once. */
  readonly substitute: (text: string) => string
  /**
   * Replaces authorized placeholders in a request target, percent-encoding
   * each substituted value.
   *
   * A resolved value is arbitrary bounded text. Written into a request path
   * verbatim, a space or a code point above U+00FF is rejected by the HTTP
   * client itself, so the value is encoded on the way in and both forms are
   * redacted on the way out.
   */
  readonly substitutePath: (text: string) => string
  /** Replaces authorized placeholders in a header record. */
  readonly substituteHeaders: (
    headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>
  ) => Record<string, string | Array<string>>
  /** Replaces resolved values in response text with their placeholders. */
  readonly redact: (text: string) => string
  /** Replaces resolved values in response bytes with their placeholders. */
  readonly redactBytes: (bytes: Uint8Array) => Buffer
  /**
   * The environment names this boundary has resolved so far, never a value.
   *
   * A transport-level rejection names the declaration the operator has to fix
   * without the diagnostic carrying the credential itself.
   */
  readonly resolvedDeclarations: () => ReadonlyArray<string>
}

/**
 * One value a boundary must never let back out, and what stands in for it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Protected {
  /** The text the child already holds and may see. */
  readonly placeholder: string
  /** The host-owned text that must never reach the child. */
  readonly value: string
}

/**
 * Mints placeholders and substitutes them lazily.
 *
 * @category models
 * @since 0.1.0
 */
export interface Vault {
  /**
   * Mints the placeholder that stands in for one declared secret.
   *
   * Minting twice for the same declaration returns the same placeholder within
   * one vault, so a target that declares a secret in two attrs sees one value.
   */
  readonly mint: (credential: Secret.HttpCredential) => string
  /** Resolves a source for a host-owned destination capability. */
  readonly resolve: (secret: Secret.Secret) => string
  /**
   * Opens one exact-origin request boundary.
   *
   * `protect` seeds the boundary with values it did not resolve itself. The
   * secret-destination path resolves its URL before the boundary exists, so
   * without this the one value that matters is the one value redaction cannot
   * see.
   */
  readonly request: (audience: string, protect?: ReadonlyArray<Protected> | undefined) => RequestBoundary
  /** Whether any placeholder has been minted. */
  readonly isEmpty: () => boolean
}

/**
 * Creates a vault.
 *
 * `read` exists so tests can supply an environment without mutating the
 * process, and so a future host layer can supply one that is not
 * `process.env`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeVault = (options: { readonly read?: Read | undefined } = {}): Vault => {
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null) ||
    Object.getOwnPropertySymbols(options).length > 0
  ) throw new TypeError("secret vault options must be a plain string-keyed object")
  const names = Object.getOwnPropertyNames(options)
  if (names.some((name) => name !== "read")) throw new TypeError("secret vault received an unknown option")
  const readDescriptor = Object.getOwnPropertyDescriptor(options, "read")
  if (readDescriptor !== undefined && (!("value" in readDescriptor) || readDescriptor.enumerable !== true)) {
    throw new TypeError("secret vault read must be an enumerable data property")
  }
  const declaredRead = readDescriptor !== undefined && "value" in readDescriptor ? readDescriptor.value : undefined
  if (declaredRead !== undefined && typeof declaredRead !== "function") {
    throw new TypeError("secret vault read must be a function")
  }
  const read: Read = declaredRead ?? ((name) => process.env[name])
  const byBinding = new Map<string, string>()
  const byPlaceholder = new Map<string, Secret.HttpCredential>()
  const resolveSecret = (secret: Secret.Secret): string => {
    const hostValue = read(secret.env)
    const value = hostValue === undefined ? secret.fallback : hostValue
    if (value === undefined || value === "") throw new SecretUnavailable(secret.env)
    if (
      typeof value !== "string" || !value.isWellFormed() ||
      Buffer.byteLength(value, "utf8") > maximumSecretValueBytes ||
      /[\u0000-\u001f\u007f]/.test(value)
    ) throw new SecretValueInvalid(secret.env)
    return value
  }
  const mint = (credential: Secret.HttpCredential): string => {
    if (!Secret.isHttpCredential(credential)) throw new TypeError("vault mint requires an HTTP credential binding")
    const snapshot = Secret.HttpSecret(credential.secret, [...credential.audiences])
    const key = JSON.stringify([
      snapshot.secret.env,
      snapshot.secret.fallback ?? null,
      snapshot.audiences
    ])
    const existing = byBinding.get(key)
    if (existing !== undefined) return existing
    const placeholder = `${placeholderPrefix}${toHex(randomBytes(32))}`
    byBinding.set(key, placeholder)
    byPlaceholder.set(placeholder, snapshot)
    return placeholder
  }
  return {
    mint,
    resolve: (secret) => {
      if (!Secret.isSecret(secret)) throw new TypeError("vault resolve requires a secret declaration")
      return resolveSecret(secret)
    },
    request: (audience, protect) => {
      let parsed: URL
      try {
        parsed = new URL(audience)
      } catch {
        throw new TypeError("secret request audience must be an HTTP origin")
      }
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== audience ||
        parsed.username !== "" || parsed.password !== ""
      ) throw new TypeError("secret request audience must be an exact HTTP origin")
      const normalized = parsed.origin
      const resolved = new Map<string, string>()
      const declarations = new Set<string>()
      // Protected text keyed by the exact bytes that must never leave, so one
      // value written in two encodings is two entries pointing at one
      // placeholder.
      const protectedValues = new Map<string, string>()
      const protectValue = (value: string, placeholder: string): void => {
        if (value === "" || protectedValues.has(value)) return
        protectedValues.set(value, placeholder)
      }
      for (const entry of protect ?? []) protectValue(entry.value, entry.placeholder)
      const replaceIn = (text: string, render: (value: string) => string): string => {
        if (byPlaceholder.size === 0 || !text.includes(placeholderPrefix)) return text
        return text.replace(placeholderPattern, (match) => {
          const credential = byPlaceholder.get(match)
          // An unminted placeholder is not ours. Leaving it untouched is what
          // keeps substitution a capability: a target cannot obtain a value
          // by spelling a placeholder it was never given.
          if (credential === undefined) return match
          if (!credential.audiences.includes(normalized)) {
            throw new SecretAudienceDenied(credential.secret.env, normalized)
          }
          const previous = resolved.get(match)
          const value = previous ?? resolveSecret(credential.secret)
          if (previous === undefined) resolved.set(match, value)
          declarations.add(credential.secret.env)
          protectValue(value, match)
          const rendered = render(value)
          protectValue(rendered, match)
          return rendered
        })
      }
      const substitute = (text: string): string => replaceIn(text, (value) => value)
      // Longest first, so a value that contains another is replaced whole
      // rather than leaving the remainder of it in the output.
      const protections = (): ReadonlyArray<readonly [string, string]> =>
        [...protectedValues.entries()].sort((left, right) => right[0].length - left[0].length)
      const redact = (text: string): string => {
        let output = text
        for (const [value, placeholder] of protections()) output = output.split(value).join(placeholder)
        return output
      }
      const redactBytes = (input: Uint8Array): Buffer => {
        let output = Buffer.from(input)
        for (const [value, placeholder] of protections()) {
          const needle = Buffer.from(value, "utf8")
          if (needle.byteLength === 0) continue
          const replacement = Buffer.from(placeholder, "utf8")
          const pieces: Array<Buffer> = []
          let offset = 0
          let index = output.indexOf(needle, offset)
          while (index !== -1) {
            pieces.push(output.subarray(offset, index), replacement)
            offset = index + needle.byteLength
            index = output.indexOf(needle, offset)
          }
          if (pieces.length > 0) {
            pieces.push(output.subarray(offset))
            output = Buffer.concat(pieces)
          }
        }
        return output
      }
      return {
        substitute,
        substitutePath: (text) => replaceIn(text, encodeURIComponent),
        resolvedDeclarations: () => [...declarations],
        substituteHeaders: (headers) => {
          const output: Record<string, string | Array<string>> = {}
          for (const [name, value] of Object.entries(headers)) {
            if (value === undefined) continue
            output[name] = typeof value === "string" ? substitute(value) : value.map(substitute)
          }
          return output
        },
        redact,
        redactBytes
      }
    },
    isEmpty: () => byPlaceholder.size === 0
  }
}

/**
 * A running substitution proxy.
 *
 * @category models
 * @since 0.1.0
 */
export interface Proxy {
  /** The loopback endpoint a child is pointed at. */
  readonly endpoint: string
  /** Mints a loopback URL that resolves one secret destination on request. */
  readonly urlFor: (secret: Secret.Secret) => string
  /** Stops the proxy and drops every in-flight connection. */
  readonly close: () => Promise<void>
}

/** Private path namespace used for secret destination capabilities. */
const secretUrlPath = "/.well-known/smithers-secret-url/"

/**
 * Maximum request body buffered for placeholder substitution.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumRequestBodyBytes = 16 * 1024 * 1024

/**
 * Maximum upstream response buffered so resolved values can be removed.
 * @category constants
 * @since 0.1.0
 */
export const maximumResponseBodyBytes = 16 * 1024 * 1024

/**
 * Elapsed deadline and socket idle timeout for one proxy-owned upstream request.
 * The deadline starts when the proxy sends the request and includes its response body.
 * @category constants
 * @since 0.1.0
 */
export const upstreamTimeoutMs = 2 * 60 * 1000

/** Hop-by-hop headers a proxy must not forward. */
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
])

const connectionHeaders = (headers: NodeHttp.IncomingHttpHeaders): ReadonlySet<string> => {
  const value = headers.connection
  const fields = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return new Set(fields.flatMap((field) => field.split(",")).map((field) => field.trim().toLowerCase()).filter(Boolean))
}

/**
 * Starts a loopback HTTP proxy that substitutes authorized placeholders.
 *
 * The proxy binds `127.0.0.1` on an ephemeral port so nothing outside the host
 * can reach it. Requests arrive in absolute form, as an HTTP proxy requires.
 * Request paths, headers, and textual bodies are substituted only after the
 * exact destination origin is known. Upstream bodies are bounded and buffered
 * so exact resolved values can be replaced before the job sees the response.
 *
 * `CONNECT` is tunnelled only when the vault is empty. Once a placeholder has
 * been minted, the bytes could contain it but are already encrypted by the
 * time they arrive, so the proxy refuses the tunnel. Secret-bearing HTTPS
 * requests must use a brokered destination from {@link Proxy.urlFor}; that path
 * performs the outbound TLS request here, where substitution is possible.
 *
 * @category constructors
 * @since 0.1.0
 */
export const startProxy = (vault: Vault): Promise<Proxy> =>
  new Promise((resolve, reject) => {
    const destinations = new Map<string, { readonly secret: Secret.Secret; readonly url: string }>()
    const destinationByDeclaration = new Map<string, string>()
    const server = NodeHttp.createServer((request, response) => {
      let target: URL
      let secretDestination = false
      let protect: ReadonlyArray<Protected> | undefined
      const requestUrl = request.url ?? ""
      if (requestUrl.startsWith(secretUrlPath)) {
        const route = requestUrl.slice(secretUrlPath.length)
        const entry = destinations.get(route)
        if (entry === undefined) {
          response.writeHead(404).end("unknown secret destination")
          return
        }
        const destination = entry.secret
        let resolved: string
        try {
          resolved = vault.resolve(destination)
        } catch (cause) {
          const message = cause instanceof SecretUnavailable || cause instanceof SecretValueInvalid
            ? cause.message
            : "secret substitution failed"
          response.writeHead(502).end(message)
          return
        }
        try {
          target = new URL(resolved)
        } catch {
          response.writeHead(502).end(`the declared secret ${destination.env} is not an http(s) URL`)
          return
        }
        if (target.protocol !== "http:" && target.protocol !== "https:") {
          response.writeHead(502).end(`the declared secret ${destination.env} is not an http(s) URL`)
          return
        }
        secretDestination = true
        // The credential here is the URL itself. An upstream that reflects the
        // request target in a body, a header, or an error page would hand it
        // straight back, so every part of it is protected by the loopback
        // capability the child already holds.
        const capability = new URL(entry.url)
        const requestTarget = `${target.pathname}${target.search}`
        protect = [
          { placeholder: entry.url, value: target.href },
          { placeholder: entry.url, value: resolved },
          { placeholder: capability.origin, value: target.origin },
          ...(requestTarget === "/" ? [] : [{ placeholder: capability.pathname, value: requestTarget }]),
          // A bare slash and an empty search occur in unrelated response text
          // too often to replace safely. The boundary sorts every admitted
          // value longest-first before redacting, so whole URLs win over parts.
          ...(target.pathname === "/" ? [] : [{ placeholder: capability.pathname, value: target.pathname }]),
          ...(target.search === "" ? [] : [{ placeholder: capability.search, value: target.search }])
        ]
      } else {
        try {
          target = new URL(requestUrl)
        } catch {
          response.writeHead(400).end("proxy requires an absolute request URL")
          return
        }
        if (target.protocol !== "http:") {
          response.writeHead(400).end("proxy forwards http requests only")
          return
        }
      }
      if (target.username !== "" || target.password !== "") {
        response.writeHead(400).end("proxy request URLs must not contain credentials")
        return
      }
      const declaredLength = Number(request.headers["content-length"] ?? "0")
      if (Number.isFinite(declaredLength) && declaredLength > maximumRequestBodyBytes) {
        response.writeHead(413).end("proxy request body is too large")
        request.resume()
        return
      }
      const chunks: Array<Buffer> = []
      let bodyBytes = 0
      let rejected = false
      request.on("data", (chunk: Buffer) => {
        if (rejected) return
        bodyBytes += chunk.byteLength
        if (bodyBytes > maximumRequestBodyBytes) {
          rejected = true
          chunks.length = 0
          response.writeHead(413).end("proxy request body is too large")
          return
        }
        chunks.push(chunk)
      })
      request.on("end", () => {
        if (rejected) return
        let headers: Record<string, string | Array<string>>
        let body: Buffer
        let path: string
        let boundary: RequestBoundary
        try {
          const forwarded: Record<string, string | Array<string> | undefined> = {}
          const nominated = connectionHeaders(request.headers)
          for (const [name, value] of Object.entries(request.headers)) {
            const lower = name.toLowerCase()
            if (!hopByHop.has(lower) && !nominated.has(lower) && lower !== "host" && lower !== "accept-encoding") {
              forwarded[name] = value
            }
          }
          forwarded["accept-encoding"] = "identity"
          boundary = vault.request(target.origin, protect)
          headers = boundary.substituteHeaders(forwarded)
          headers.host = target.host
          const raw = Buffer.concat(chunks)
          const text = raw.toString("utf8")
          // Substituting a body only makes sense when it is text that survives
          // a round trip. Binary bodies are forwarded untouched.
          const substituted = Buffer.byteLength(text, "utf8") === raw.byteLength
            ? Buffer.from(boundary.substitute(text), "utf8")
            : raw
          body = substituted
          if (body.byteLength !== raw.byteLength) headers["content-length"] = String(body.byteLength)
          path = secretDestination
            ? `${target.pathname}${target.search}`
            : boundary.substitutePath(`${target.pathname}${target.search}`)
        } catch (cause) {
          const denied = cause instanceof SecretAudienceDenied
          const message = cause instanceof SecretUnavailable || cause instanceof SecretValueInvalid || denied
            ? cause.message
            : "secret substitution failed"
          response.writeHead(denied ? 403 : 502).end(message)
          return
        }
        const requestUpstream = target.protocol === "https:" ? NodeHttps.request : NodeHttp.request
        // Constructing the client request validates the method, the request
        // target, and every header value, and throws synchronously when one is
        // not something HTTP can carry. Outside a handler that throw is an
        // uncaught exception in an event listener, which ends the whole build
        // process instead of this one target.
        let upstream: NodeHttp.ClientRequest | undefined
        let incoming: NodeHttp.IncomingMessage | undefined
        let deadline: ReturnType<typeof setTimeout> | undefined
        const responseChunks: Array<Buffer> = []
        let settled = false
        const clear = () => {
          clearTimeout(deadline)
          upstream?.setTimeout(0)
          chunks.length = 0
          responseChunks.length = 0
        }
        const fail = (message: string) => {
          if (settled) return
          settled = true
          clear()
          incoming?.destroy()
          upstream?.destroy()
          if (response.headersSent || response.destroyed) response.destroy()
          else response.writeHead(502).end(boundary.redact(message))
        }
        const failError = (error: NodeJS.ErrnoException) => {
          // Error messages can contain secret destinations. Expose only a
          // bounded transport code, and redact even that request-local value.
          const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
            ? `: ${error.code}`
            : ""
          fail(`upstream request failed${code}`)
        }
        try {
          upstream = requestUpstream(
            {
              protocol: target.protocol,
              hostname: target.hostname,
              port: target.port === "" ? (target.protocol === "https:" ? 443 : 80) : target.port,
              method: request.method,
              path,
              headers
            },
            (upstreamResponse) => {
              incoming = upstreamResponse
              upstreamResponse.once("error", failError)
              const endedEarly = () => fail("upstream request failed: upstream response ended early")
              upstreamResponse.once("aborted", endedEarly)
              upstreamResponse.once("close", endedEarly)
              if (settled) {
                upstreamResponse.destroy()
                return
              }
              const encoding = upstreamResponse.headers["content-encoding"]
              if (encoding !== undefined && encoding !== "identity") {
                fail("upstream returned an encoded response")
                return
              }
              let responseBytes = 0
              upstreamResponse.on("data", (chunk: Buffer) => {
                if (settled) return
                responseBytes += chunk.byteLength
                if (responseBytes > maximumResponseBodyBytes) {
                  fail("upstream response is too large")
                  return
                }
                responseChunks.push(chunk)
              })
              upstreamResponse.on("end", () => {
                if (settled) return
                const responseHeaders: Record<string, string | Array<string>> = {}
                const nominated = connectionHeaders(upstreamResponse.headers)
                for (const [name, value] of Object.entries(upstreamResponse.headers)) {
                  const lower = name.toLowerCase()
                  if (
                    value !== undefined && !hopByHop.has(lower) && !nominated.has(lower) &&
                    lower !== "content-length" && lower !== "content-encoding"
                  ) {
                    responseHeaders[name] = Array.isArray(value)
                      ? value.map(boundary.redact)
                      : boundary.redact(value)
                  }
                }
                const redacted = boundary.redactBytes(Buffer.concat(responseChunks))
                responseHeaders["content-length"] = String(redacted.byteLength)
                settled = true
                clear()
                response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
                response.end(redacted)
              })
            }
          )
        } catch {
          const named = boundary.resolvedDeclarations()
          fail(
            named.length === 0
              ? "the request could not be represented as an http request"
              : `the declared secret ${named.join(", ")} produced an invalid request target`
          )
          return
        }
        const timedOut = () => fail("upstream request failed: timed out")
        upstream.setTimeout(upstreamTimeoutMs, timedOut)
        upstream.once("error", failError)
        response.once("close", () => {
          if (!response.writableEnded) fail("upstream request failed: child disconnected")
        })
        deadline = setTimeout(timedOut, upstreamTimeoutMs)
        upstream.end(body)
      })
    })
    server.on("connect", (request, socket: NodeNet.Socket, head: Buffer) => {
      if (!vault.isEmpty()) {
        socket.end("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n")
        return
      }
      const authority = parseConnectAuthority(request.url ?? "")
      if (authority === undefined) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
        return
      }
      let upstream: NodeNet.Socket
      let connected = false
      try {
        upstream = NodeNet.connect(authority, () => {
          connected = true
          clearTimeout(deadline)
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          if (head.byteLength > 0) upstream.write(head)
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
      } catch {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        return
      }
      const drop = () => {
        clearTimeout(deadline)
        if (!connected && !socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
        else socket.destroy()
        upstream.destroy()
      }
      // A destination that black-holes the SYN never connects and never
      // errors. Without a deadline the child's CONNECT would wait for the
      // operating system's whole TCP connect timeout, so the same elapsed
      // bound as a proxy-owned request applies here.
      const deadline = setTimeout(drop, upstreamTimeoutMs)
      upstream.once("error", drop)
      socket.once("error", drop)
      socket.once("close", () => upstream.destroy())
      upstream.once("close", () => socket.destroy())
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("secret proxy did not bind a loopback port"))
        return
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        urlFor: (secret) => {
          if (!Secret.isSecret(secret)) throw new TypeError("proxy urlFor requires a secret declaration")
          const snapshot = Secret.Secret(secret.env, secret.fallback === undefined ? {} : { fallback: secret.fallback })
          const key = JSON.stringify([snapshot.env, snapshot.fallback ?? null])
          const existing = destinationByDeclaration.get(key)
          if (existing !== undefined) return existing
          const route = toHex(randomBytes(32))
          const url = `http://127.0.0.1:${address.port}${secretUrlPath}${route}`
          destinations.set(route, { secret: snapshot, url })
          destinationByDeclaration.set(key, url)
          return url
        },
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
