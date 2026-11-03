import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import { isIP } from "node:net"
import { checkServerIdentity, getCACertificates, type ConnectionOptions } from "node:tls"

class PolicyError extends Error {}

export const parse = (value: string) => {
  try {
    const url = new URL(value)
    if ((url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "") return url
  } catch { /* URL errors carry their input. Never forward them. */ }
  throw new PolicyError("DATABASE_URL is not a valid Postgres URL")
}

const loopback = (host: string) => host === "localhost" || host === "localhost." || host === "::1" ||
  (isIP(host) === 4 && host.startsWith("127."))

/**
 * The native Effect driver ignores sslrootcert and channel_binding. Give TLS its trust roots explicitly, and always
 * verify the certificate chain AND the authority hostname. No URL field can change the endpoint after validation.
 */
export const sslFor = (connection: string): ConnectionOptions | undefined => {
  const url = parse(connection)
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const refuse = (reason: string): never => { throw new PolicyError(`DATABASE_URL for ${host} ${reason}`) }
  if (["host", "hostaddr", "port", "service", "servicefile"].some((key) => url.searchParams.has(key))) refuse("has unsupported endpoint overrides")
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

/** Only our own fixed policy errors may be forwarded; driver errors can embed arbitrary URLs. */
export const diagnostic = (error: unknown, connection: string): string => {
  if (error instanceof PolicyError) return error.message
  try { return `database operation failed for ${parse(connection).hostname.replace(/^\[|\]$/g, "").toLowerCase()}` }
  catch { return "DATABASE_URL is not a valid Postgres URL" }
}

/** libpq reads PGDATABASE as a literal name, not a URI. Supply validated, explicit connection fields. */
export const libpqEnvironment = (connection: string, env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const ssl = sslFor(connection)
  const url = parse(connection)
  const parameters: Readonly<Record<string, string>> = {
    connect_timeout: "PGCONNECT_TIMEOUT", application_name: "PGAPPNAME", channel_binding: "PGCHANNELBINDING",
    ssl_min_protocol_version: "PGSSLMINPROTOCOLVERSION", ssl_max_protocol_version: "PGSSLMAXPROTOCOLVERSION",
    sslcert: "PGSSLCERT", sslkey: "PGSSLKEY", sslcertmode: "PGSSLCERTMODE", sslcrl: "PGSSLCRL", sslcrldir: "PGSSLCRLDIR",
    target_session_attrs: "PGTARGETSESSIONATTRS", client_encoding: "PGCLIENTENCODING", sslnegotiation: "PGSSLNEGOTIATION",
  }
  const extras: NodeJS.ProcessEnv = {}
  for (const [key, value] of url.searchParams) {
    if (key === "sslmode" || key === "sslrootcert") continue
    if (!Object.hasOwn(parameters, key) || url.searchParams.getAll(key).length !== 1) {
      throw new PolicyError(`DATABASE_URL for ${url.hostname} has unsupported libpq parameters`)
    }
    extras[parameters[key]!] = value
  }
  // Neither ambient services/addresses nor GSS may replace the validated endpoint and verified TLS transport.
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PG")))
  return {
    ...clean, ...extras,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    ...(url.username ? { PGUSER: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
    PGSSLMODE: ssl === undefined ? "disable" : "verify-full",
    ...(ssl === undefined ? {} : { PGSSLROOTCERT: url.searchParams.get("sslrootcert") || "system" }),
    PGGSSENCMODE: "disable", PGOPTIONS: "-c default_transaction_read_only=on",
  }
}
