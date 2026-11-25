/**
 * Who a call acts as. A {@link Principal} is opaque: only
 * {@link Credentials} mints one, from {@link DoorEvidence} an adapter hands
 * over. Evidence says how a call arrived, never who made it, so an adapter
 * cannot name a person, and the door alone decides whether a call is the
 * person's own or a delegate's.
 *
 * `mcp`, `incur`, `sdk` and `gui.frame` always mint a delegate (`agent`,
 * `agent`, `flow`, `app`). Only `gui.strip`, `gui.key`, `gui.slash` and
 * `gui.palette` mint the person.
 *
 * A principal belongs to the {@link Credentials} that minted it. Another
 * issuer in the same process reads it as no authority. A GUI credential
 * authenticates one door class: the host's person session, or one plugin
 * installation's frame. What the evidence claims never widens that.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

/**
 * What a delegate is: a person's agent, a framed plugin app, or a running flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Act = "agent" | "app" | "flow"

/**
 * A host-drawn door only the person can use.
 *
 * @category models
 * @since 1.0.0
 */
export type PersonDoor = "strip" | "key" | "slash" | "palette"

/**
 * Evidence of an MCP call: its transport and a reference to its bearer token.
 *
 * @category models
 * @since 1.0.0
 */
export interface McpEvidence {
  readonly kind: "mcp"
  readonly transport: "stdio" | "http"
  readonly tokenRef: string
}

/**
 * Evidence of a CLI or skill call: the session file it read.
 *
 * @category models
 * @since 1.0.0
 */
export interface IncurEvidence {
  readonly kind: "incur"
  readonly sessionFile: string
}

/**
 * Evidence of an SDK call: the credential of the run that makes it.
 *
 * @category models
 * @since 1.0.0
 */
export interface SdkEvidence {
  readonly kind: "sdk"
  readonly runCredential: Redacted.Redacted<string>
}

/**
 * Evidence of a press, key, slash command or palette entry in host-drawn UI.
 *
 * @category models
 * @since 1.0.0
 */
export interface PersonEvidence {
  readonly kind: "gui"
  readonly door: PersonDoor
  readonly session: string
}

/**
 * Evidence of a message from a plugin's sandboxed frame.
 *
 * @category models
 * @since 1.0.0
 */
export interface FrameEvidence {
  readonly kind: "gui"
  readonly door: "frame"
  readonly session: string
  readonly plugin: string
}

/**
 * How a call arrived.
 *
 * @category models
 * @since 1.0.0
 */
export type DoorEvidence = McpEvidence | IncurEvidence | SdkEvidence | PersonEvidence | FrameEvidence

/**
 * The door a principal came through.
 *
 * @category models
 * @since 1.0.0
 */
export type Door = "mcp" | "incur" | "sdk" | `gui.${PersonDoor | "frame"}`

/**
 * What a verified credential grants: its subject, its session, and the
 * capabilities it holds. `ceiling`, when set, narrows them (a plugin's
 * declared capabilities, a token's scope).
 *
 * @category models
 * @since 1.0.0
 */
export interface Session {
  readonly subject: string
  readonly session: string
  readonly capabilities: ReadonlyArray<string>
  readonly ceiling?: ReadonlyArray<string>
  /** What a GUI credential authenticates. A GUI door mints nothing without it. */
  readonly gui?: GuiBinding
}

/**
 * The door class a GUI credential authenticates: the host's own person
 * session, or the frame of one plugin installation.
 *
 * @category models
 * @since 1.0.0
 */
export type GuiBinding =
  | { readonly door: "person" }
  | { readonly door: "frame"; readonly plugin: string }

/**
 * What a principal may do. `act` is `undefined` for the person.
 *
 * @category models
 * @since 1.0.0
 */
export interface Authority {
  readonly subject: string
  readonly session: string
  readonly door: Door
  readonly act: Act | undefined
  readonly capabilities: ReadonlyArray<string>
  readonly plugin?: string
}

/**
 * Why a credential or receipt was refused.
 *
 * @category errors
 * @since 1.0.0
 */
export class AuthRefused extends Schema.TaggedError<AuthRefused>()("@smthrs/app-core/AuthRefused", {
  reason: Schema.Literals([
    "unknown_credential",
    "unknown_door",
    "door_mismatch",
    "not_a_person",
    "receipt_invalid",
    "receipt_expired"
  ]),
  detail: Schema.String
}) {}

declare const PrincipalBrand: unique symbol

/**
 * An opaque, minted identity. It has no fields: an object built anywhere but
 * {@link Credentials} carries no authority.
 *
 * @category models
 * @since 1.0.0
 */
export interface Principal {
  readonly [PrincipalBrand]: "Principal"
}

/**
 * How long a receipt for a protected act lives, in milliseconds.
 *
 * @category limits
 * @since 1.0.0
 */
export const receiptLifetime = 60_000

/**
 * The one protected act a receipt confirms: an operation and the hash of its
 * exact payload.
 *
 * @category models
 * @since 1.0.0
 */
export interface Confirmed {
  readonly operation: string
  readonly target: string
}

/**
 * Mints principals from door evidence, and issues and redeems the single-use
 * receipts protected acts need.
 *
 * @category models
 * @since 1.0.0
 */
export interface Credentials {
  /** Verifies the evidence and mints the principal its door allows. */
  readonly mint: (evidence: DoorEvidence) => Effect.Effect<Principal, AuthRefused>
  /**
   * What a principal may do, or `undefined` for an object this issuer did not
   * mint: a forgery, or a principal another issuer minted.
   */
  readonly authority: (principal: Principal) => Authority | undefined
  /** Issues a receipt for one protected act. Refuses a principal that is not the person. */
  readonly receipt: (principal: Principal, confirmed: Confirmed) => Effect.Effect<string, AuthRefused>
  /**
   * Spends a receipt: once, within {@link receiptLifetime}, by the same session, for the same act.
   * Any attempt by a principal this issuer minted spends it; a principal it did not mint is refused
   * and spends nothing.
   */
  readonly redeem: (token: string, principal: Principal, confirmed: Confirmed) => Effect.Effect<void, AuthRefused>
}

/**
 * Resolves evidence to the session its credential grants.
 *
 * @category models
 * @since 1.0.0
 */
export type Verify = (evidence: DoorEvidence) => Effect.Effect<Session, AuthRefused>

const doorOf = (evidence: DoorEvidence): Door => evidence.kind === "gui" ? `gui.${evidence.door}` : evidence.kind

const personDoors: ReadonlySet<string> = new Set<PersonDoor>(["strip", "key", "slash", "palette"])

const unknownDoor = (detail: string): AuthRefused => new AuthRefused({ reason: "unknown_door", detail })

const mismatch = (detail: string): AuthRefused => new AuthRefused({ reason: "door_mismatch", detail })

/**
 * Evidence rebuilt from only the fields its door takes, or a refusal for a
 * door this module does not name. Extra fields on the input are dropped, so
 * none of them reaches a verifier or selects an authority.
 *
 * @category validation
 * @since 1.0.0
 */
export const evidenceOf = (input: unknown): DoorEvidence | AuthRefused => {
  if (typeof input !== "object" || input === null) return unknownDoor("the evidence is not an object")
  const from = input as { readonly [field: string]: unknown }
  const kind = from["kind"]
  switch (kind) {
    case "mcp": {
      const transport = from["transport"]
      const tokenRef = from["tokenRef"]
      if ((transport !== "stdio" && transport !== "http") || typeof tokenRef !== "string") {
        return unknownDoor("mcp evidence needs a transport and a token reference")
      }
      return { kind, transport, tokenRef }
    }
    case "incur": {
      const sessionFile = from["sessionFile"]
      if (typeof sessionFile !== "string") return unknownDoor("incur evidence needs a session file")
      return { kind, sessionFile }
    }
    case "sdk": {
      const runCredential = from["runCredential"]
      if (!Redacted.isRedacted(runCredential)) return unknownDoor("sdk evidence needs a run credential")
      return { kind, runCredential: runCredential as Redacted.Redacted<string> }
    }
    case "gui": {
      const door = from["door"]
      const session = from["session"]
      if (typeof session !== "string") return unknownDoor("gui evidence needs a session")
      if (door === "frame") {
        const plugin = from["plugin"]
        if (typeof plugin !== "string") return unknownDoor("frame evidence needs a plugin")
        return { kind, door, session, plugin }
      }
      if (typeof door === "string" && personDoors.has(door)) return { kind, door: door as PersonDoor, session }
      return unknownDoor("the gui door is not one of strip, key, slash, palette or frame")
    }
    default:
      return unknownDoor("the door is not one of mcp, incur, sdk or gui")
  }
}

// Who the verified session lets this door act as. The session's own binding
// decides it: evidence only has to agree.
const bound = (
  evidence: DoorEvidence,
  session: Session
): { readonly act: Act | undefined; readonly plugin?: string } | AuthRefused => {
  const verified = session.gui
  if (evidence.kind !== "gui") {
    if (verified !== undefined) return mismatch(`a gui credential does not open the ${evidence.kind} door`)
    return { act: evidence.kind === "sdk" ? "flow" : "agent" }
  }
  if (verified === undefined) return mismatch("the credential authenticates no gui door")
  if (evidence.door === "frame") {
    if (verified.door !== "frame") return mismatch("a person session does not open a frame")
    if (typeof verified.plugin !== "string" || verified.plugin !== evidence.plugin) {
      return mismatch("the frame credential belongs to another plugin installation")
    }
    return { act: "app", plugin: verified.plugin }
  }
  if (verified.door !== "person") return mismatch("a frame credential does not open a person door")
  return { act: undefined }
}

const within = (held: ReadonlyArray<string>, ceiling: ReadonlyArray<string>): ReadonlyArray<string> =>
  held.filter((capability) => ceiling.includes(capability))

const randomToken = (): string =>
  Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")

/**
 * Builds the credential service over a verifier. `now` is the clock receipts
 * expire by.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: { readonly verify: Verify; readonly now?: () => number }): Credentials => {
  const now = options.now ?? (() => Date.now())
  // The only record of what a principal may do, private to this issuer.
  // Nothing outside this closure can add to it, so a forged object, or a
  // principal another issuer minted, reads as no authority.
  const minted = new WeakMap<object, Authority>()
  const authority = (principal: Principal): Authority | undefined =>
    typeof principal === "object" && principal !== null ? minted.get(principal) : undefined
  const receipts = new Map<
    string,
    { readonly session: string; readonly confirmed: Confirmed; readonly expires: number }
  >()
  return {
    authority,
    mint: (input) =>
      Effect.suspend(() => {
        const evidence = evidenceOf(input)
        if (evidence instanceof AuthRefused) return Effect.fail(evidence)
        return Effect.flatMap(options.verify(evidence), (session): Effect.Effect<Principal, AuthRefused> => {
          const who = bound(evidence, session)
          if (who instanceof AuthRefused) return Effect.fail(who)
          const ceiling = session.ceiling
          const facts: Authority = Object.freeze({
            subject: session.subject,
            session: session.session,
            door: doorOf(evidence),
            act: who.act,
            capabilities: Object.freeze(
              ceiling === undefined ? [...session.capabilities] : [...within(session.capabilities, ceiling)]
            ),
            ...(who.plugin === undefined ? {} : { plugin: who.plugin })
          })
          const principal = Object.freeze(Object.create(null)) as Principal
          minted.set(principal, facts)
          return Effect.succeed(principal)
        })
      }),
    receipt: (principal, confirmed) =>
      Effect.suspend(() => {
        const facts = authority(principal)
        if (facts === undefined || facts.act !== undefined) {
          return Effect.fail(
            new AuthRefused({ reason: "not_a_person", detail: "only the person confirms a protected act" })
          )
        }
        const token = randomToken()
        // Receipts nobody spent do not pile up: drop the expired ones first.
        for (const [issued, receipt] of receipts) if (now() >= receipt.expires) receipts.delete(issued)
        receipts.set(token, { session: facts.session, confirmed: { ...confirmed }, expires: now() + receiptLifetime })
        return Effect.succeed(token)
      }),
    redeem: (token, principal, confirmed) =>
      Effect.suspend(() => {
        const facts = authority(principal)
        // A principal this issuer never minted touches no receipt: it cannot
        // burn a token that belongs to someone here.
        if (facts === undefined) {
          return Effect.fail(new AuthRefused({ reason: "not_a_person", detail: "only the person spends a receipt" }))
        }
        const receipt = receipts.get(token)
        // Spent on first sight by any principal of this issuer, whatever the
        // outcome: a receipt never gets a second try.
        receipts.delete(token)
        if (facts.act !== undefined) {
          return Effect.fail(new AuthRefused({ reason: "not_a_person", detail: "only the person spends a receipt" }))
        }
        if (
          receipt === undefined || receipt.session !== facts.session ||
          receipt.confirmed.operation !== confirmed.operation || receipt.confirmed.target !== confirmed.target
        ) {
          return Effect.fail(
            new AuthRefused({ reason: "receipt_invalid", detail: "the receipt does not confirm this act" })
          )
        }
        if (now() >= receipt.expires) {
          return Effect.fail(
            new AuthRefused({ reason: "receipt_expired", detail: "the receipt is older than 60 seconds" })
          )
        }
        return Effect.void
      })
  }
}

interface Granted {
  readonly subject: string
  readonly session: string
  readonly capabilities: ReadonlyArray<string>
  readonly ceiling?: ReadonlyArray<string>
}

/**
 * A credential a {@link sessions} table holds: the door it is good for, and
 * what it grants. A GUI credential names its door class: `person` for the
 * host's own session, or `frame` with the plugin installation it was issued
 * to.
 *
 * @category models
 * @since 1.0.0
 */
export type Grant =
  | (Granted & { readonly kind: "mcp" | "incur" | "sdk" })
  | (Granted & { readonly kind: "gui"; readonly door: "person" })
  | (Granted & { readonly kind: "gui"; readonly door: "frame"; readonly plugin: string })

const credentialOf = (evidence: DoorEvidence): string => {
  switch (evidence.kind) {
    case "mcp":
      return evidence.tokenRef
    case "incur":
      return evidence.sessionFile
    case "sdk":
      return Redacted.value(evidence.runCredential)
    case "gui":
      return evidence.session
  }
}

/**
 * A verifier over a fixed table, keyed by credential. A credential is good
 * only for the door kind it was granted for: an MCP token is not a GUI
 * session, and a frame credential is not a person session.
 *
 * A frame holds what its grant holds, inside the grant's own ceiling and
 * inside its plugin's entry in `plugins`. Every ceiling narrows; none
 * replaces another. The plugin is the one the grant names, never the one the
 * evidence claims, and a plugin the table does not name holds nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const sessions = (
  grants: Readonly<Record<string, Grant>>,
  plugins: Readonly<Record<string, ReadonlyArray<string>>> = {}
): Verify =>
(evidence) =>
  Effect.suspend(() => {
    const credential = credentialOf(evidence)
    const grant = Object.hasOwn(grants, credential) ? grants[credential] : undefined
    if (grant === undefined || grant.kind !== evidence.kind) {
      return Effect.fail(
        new AuthRefused({ reason: "unknown_credential", detail: `no ${evidence.kind} credential matches` })
      )
    }
    if (grant.kind !== "gui") {
      return Effect.succeed<Session>({
        subject: grant.subject,
        session: grant.session,
        capabilities: grant.capabilities,
        ...(grant.ceiling === undefined ? {} : { ceiling: grant.ceiling })
      })
    }
    if (grant.door === "frame") {
      const installed = Object.hasOwn(plugins, grant.plugin) ? plugins[grant.plugin] ?? [] : []
      return Effect.succeed<Session>({
        subject: grant.subject,
        session: grant.session,
        capabilities: grant.capabilities,
        ceiling: grant.ceiling === undefined ? installed : within(grant.ceiling, installed),
        gui: { door: "frame", plugin: grant.plugin }
      })
    }
    if (grant.door !== "person") {
      return Effect.fail(new AuthRefused({ reason: "unknown_door", detail: "the grant names no gui door class" }))
    }
    return Effect.succeed<Session>({
      subject: grant.subject,
      session: grant.session,
      capabilities: grant.capabilities,
      ...(grant.ceiling === undefined ? {} : { ceiling: grant.ceiling }),
      gui: { door: "person" }
    })
  })
