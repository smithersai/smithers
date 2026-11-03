import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { checkServerIdentity, getCACertificates, type ConnectionOptions } from "node:tls"
import { Effect, Redacted } from "effect"
import * as Database from "../../db/Database.ts"

const parse = (value: string) => {
  try {
    const url = new URL(value)
    if ((url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "") return url
  } catch { /* URL errors carry their input. Never forward them. */ }
  throw new Error("DATABASE_URL is not a valid Postgres URL")
}

const loopback = (host: string) => host === "localhost" || host === "localhost." || host === "::1" ||
  (isIP(host) === 4 && host.startsWith("127."))

/**
 * The native Effect driver ignores sslrootcert and channel_binding. Give TLS its trust roots explicitly, and always
 * verify the certificate chain AND the authority hostname. No URL field can change the endpoint after validation.
 */
export const sslFor = (connection: Redacted.Redacted<string>): ConnectionOptions | undefined => {
  const url = parse(Redacted.value(connection))
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const refuse = (reason: string): never => { throw new Error(`DATABASE_URL for ${host} ${reason}`) }
  if (["host", "hostaddr", "port"].some((key) => url.searchParams.has(key))) refuse("has unsupported endpoint overrides")
  if (["sslmode", "sslrootcert"].some((key) => url.searchParams.getAll(key).length > 1)) refuse("has ambiguous TLS parameters")
  const mode = url.searchParams.get("sslmode")
  const pin = url.searchParams.get("sslrootcert")
  if (mode !== "verify-full" && !(mode === "require" && pin)) {
    if (loopback(host) && (pin === null || pin === "")) return undefined
    refuse("requires sslmode=verify-full or sslmode=require with a pinned CA")
  }
  let ca: string | ReadonlyArray<string>
  if (pin !== null && pin !== "") {
    try {
      ca = readFileSync(pin, "utf8")
      // A missing, empty, malformed or non-CA pin must never silently fall back to public roots.
      const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
      if (certificates === null || certificates.some((certificate) => !new X509Certificate(certificate).ca)) throw new Error("invalid CA")
    } catch {
      return refuse("has an unusable pinned CA")
    }
  } else {
    // Includes Node's bundled roots, enabled system roots and NODE_EXTRA_CA_CERTS, loaded at process startup.
    ca = getCACertificates("default")
  }
  return {
    ca: [...(typeof ca === "string" ? [ca] : ca)],
    rejectUnauthorized: true,
    ...(isIP(host) === 0 ? { servername: host } : {}),
    checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate),
  }
}

/** Validate before any deployment lookup or connection; retain the app's one Effect SQL client configuration. */
export const layer = (url: Redacted.Redacted<string>) => Database.layer(Effect.succeed(url), sslFor(url))

/** Neon's API requests channel binding, unsupported by this driver. Require verified TLS with the Node root store. */
export const neonConnectionUri = (uri: string): Redacted.Redacted<string> => {
  const url = parse(uri)
  url.searchParams.set("sslmode", "verify-full")
  url.searchParams.delete("channel_binding")
  return Redacted.make(url.toString())
}
