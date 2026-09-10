/**
 * Capability values, wildcard policy patterns, and effect-tier
 * classification.
 *
 * Reference: https://capability.smithers.sh/concepts/resource-globs/
 *
 * @since 0.1.0
 */
import { type Brand, Option, Schema } from "effect"

/**
 * The maximum UTF-16 length of an exact or patterned capability resource.
 *
 * Exact requests and authored patterns share the bound so permission failures,
 * journal payloads, matching work, and exact-pattern derivation all have one
 * finite input contract. Adapters must reject or summarize a larger host value
 * before constructing a capability rather than carrying it into authorization.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const maxResourceLength = 4096

/**
 * The maximum pattern-length times resource-length work a match may perform.
 *
 * The matcher is O(pattern length times resource length) in the worst case and
 * {@link matches} returns `false` when the product exceeds this budget.
 * `Permission.evaluate` returns `deny` for a rule it cannot decide, and
 * {@link withinMatchBudget} reports whether a pair is decidable. The budget
 * covers every supported pair up to the 4096-unit {@link maxResourceLength}
 * limit and remains a defense for unchecked structural values. A pattern
 * ending in ` *` costs at most two passes.
 *
 * @since 0.1.0
 * @category constants
 * @slop
 */
export const maxMatchWork = maxResourceLength * maxResourceLength

/**
 * Schema for host operations that the permission kernel can authorize.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const Action = Schema.Literals(
  [
    "fs:read",
    "fs:write",
    "net:get",
    "net:post",
    "model:call",
    "proc:spawn",
    "jj:status",
    "jj:diff",
    "jj:snapshot",
    "jj:restore",
    "jj:workspace-add",
    "jj:workspace-forget",
    "jj:root",
    "jj:revert"
  ] as const
)

/**
 * A host operation that the permission kernel can authorize.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Action = typeof Action.Type

/**
 * Schema for action selectors accepted in capability patterns.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const PatternAction = Schema.Literals(
  [...Action.literals, "fs:*", "net:*", "model:*", "proc:*", "jj:*", "*"] as const
)

/**
 * An action selector accepted in a capability pattern.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PatternAction = typeof PatternAction.Type

const actions: ReadonlySet<string> = new Set(Action.literals)
const patternActions: ReadonlySet<string> = new Set(PatternAction.literals)
const isAction = (value: string): value is Action => actions.has(value)
const isPatternAction = (value: string): value is PatternAction => patternActions.has(value)
const PatternResource = Schema.String.check(Schema.isMaxLength(maxResourceLength))

/**
 * An exact adapter request subject to authorization.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export class Capability extends Schema.Class<Capability, Brand.Brand<"@smthrs/capability/Capability">>(
  "@smthrs/capability/Capability"
)({
  action: Action,
  resource: PatternResource
}) {}

/**
 * Constructs an exact capability.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make = (action: Action, resource: string): Capability => new Capability({ action, resource })

/**
 * Formats a capability or a capability pattern for storage, display, and
 * durable key input.
 *
 * `Capability` and `CapabilityPattern` have distinct nominal brands but share
 * the encoded `{action, resource}` shape. Both use this renderer to preserve
 * byte-identical durable identities.
 *
 * The function throws an `Error` that names an invalid action. Runtime
 * validation prevents invalid structural inputs from colliding with valid
 * durable identities.
 *
 * @since 0.1.0
 * @category formatting
 * @slop
 */
export const format = (capability: {
  readonly action: Action | PatternAction
  readonly resource: string
}): string => {
  if (!isPatternAction(capability.action)) {
    throw new Error(`Invalid capability action: ${capability.action}`)
  }
  return `${capability.action}:${capability.resource}`
}

/**
 * Parses an exact capability. The action is the first two colon-separated
 * components; all remaining text belongs to the resource.
 *
 * @since 0.1.0
 * @category parsing
 * @slop
 */
export const parse = (input: string): Option.Option<Capability> => {
  const components = input.split(":")
  const namespace = components[0]
  const operation = components[1]
  if (namespace === undefined || operation === undefined || components.length < 3) {
    return Option.none()
  }
  const action = `${namespace}:${operation}`
  const resource = components.slice(2).join(":")
  return isAction(action) && resource.length <= maxResourceLength
    ? Option.some(make(action, resource))
    : Option.none()
}

/**
 * An action and resource glob used to grant or deny a family of capabilities.
 * The matcher compares the pattern against the whole resource byte-exactly
 * over UTF-16 code units. It performs no path normalization and no case
 * folding, so `\` is an ordinary character that never matches `/`, and `A:/x`
 * never matches `a:/X`.
 *
 * `*` matches any run of UTF-16 code units, including path separators and
 * newlines. `?` matches exactly one UTF-16 code unit, so an astral character
 * such as an emoji requires two `?` characters. A trailing ` *` also matches
 * the bare resource without trailing argument text. This rule makes a
 * `proc:spawn` command grant such as `npm *` grant bare `npm`.
 *
 * Apart from an identical resource, {@link subsumes} can prove only the `**`
 * wildcard form. A grant written `/workspace/*` can match `/workspace/src/a.ts`
 * but cannot be proven to cover it; only the identical `/workspace/*` pattern
 * is provable. Use `**` when an envelope must prove coverage of other
 * resources. The grammar has no escape. Callers whose
 * resources can contain `*` or `?`, including URLs with query strings and
 * command lines, must not build patterns by string concatenation. Use
 * {@link patternFromCapability} to derive exact grants safely.
 *
 * Matching costs O(pattern length times resource length) in the worst case.
 * Both resources are limited to {@link maxResourceLength}, and
 * {@link maxMatchWork} remains a fail-closed guard for unchecked structural
 * inputs at the host boundary.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export class CapabilityPattern extends Schema.Class<
  CapabilityPattern,
  Brand.Brand<"@smthrs/capability/CapabilityPattern">
>("@smthrs/capability/CapabilityPattern")({
  action: PatternAction,
  resource: PatternResource
}) {}

/**
 * Parses a formatted capability pattern.
 *
 * The wildcard action `*` occupies the first component. Every other action
 * occupies the first two components. All remaining text belongs to the
 * resource, including colons and an empty string. Missing components and
 * unknown actions return `Option.none()`, with one single-token exception:
 * the bare `*` is the whole-authority sentinel that `@smthrs/registry`
 * markdown discovery emits for a flow whose frontmatter declares no
 * `capabilities:`. Plans persist that string in durable key material, so the
 * emitted form cannot change; this parser owns its meaning instead and reads
 * it as `{ action: "*", resource: "**" }`. The resource is `**` and not `*`
 * because {@link subsumes} recognises only `**` as recursive, so a grant
 * written `*` could be proven to cover only the identical `*` resource and
 * never any other. Every other missing component remains a rejection, not a
 * default.
 *
 * @since 0.1.0
 * @category parsing
 * @slop
 */
export const parsePattern = (input: string): Option.Option<CapabilityPattern> => {
  const components = input.split(":")
  if (components[0] === "*") {
    if (components.length < 2) {
      // One component and it is `*`: the input is exactly the bare sentinel.
      return Option.some(new CapabilityPattern({ action: "*", resource: "**" }))
    }
    const resource = components.slice(1).join(":")
    return resource.length <= maxResourceLength
      ? Option.some(new CapabilityPattern({ action: "*", resource }))
      : Option.none()
  }
  const namespace = components[0]
  const operation = components[1]
  if (namespace === undefined || operation === undefined || components.length < 3) {
    return Option.none()
  }
  const action = `${namespace}:${operation}`
  const resource = components.slice(2).join(":")
  return isPatternAction(action) && resource.length <= maxResourceLength
    ? Option.some(new CapabilityPattern({ action, resource }))
    : Option.none()
}

/**
 * Derives an exact pattern from a capability when the glob grammar can
 * represent the resource exactly.
 *
 * The function returns `Option.none()` when the resource is longer than
 * {@link maxResourceLength} or contains `*` or `?`. The grammar has no escape
 * for those metacharacters, so returning a pattern would silently widen the
 * grant. Quotes, newlines, and other literal text are accepted. The derived
 * pattern matches that resource and nothing else because the matcher neither
 * normalizes text nor folds case.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const patternFromCapability = (capability: Capability): Option.Option<CapabilityPattern> =>
  capability.resource.length > maxResourceLength ||
    capability.resource.includes("*") || capability.resource.includes("?")
    ? Option.none()
    : Option.some(new CapabilityPattern({ action: capability.action, resource: capability.resource }))

const matchesAction = (pattern: PatternAction, action: Action): boolean =>
  pattern === "*" || pattern === action || (pattern.endsWith(":*") && action.startsWith(pattern.slice(0, -1)))

/**
 * Reports whether {@link matches} can decide a pattern and exact capability
 * within {@link maxMatchWork}.
 *
 * An action mismatch is decidable without resource matching. When the action
 * selects the capability, the pattern-length times resource-length product
 * must fit within the work budget.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const withinMatchBudget = (pattern: CapabilityPattern, capability: Capability): boolean =>
  !matchesAction(pattern.action, capability.action) ||
  pattern.resource.length * capability.resource.length <= maxMatchWork

/**
 * Iterative glob matcher over UTF-16 code units: `*` matches any run of
 * units (path separators and newlines included), `?` matches exactly one
 * unit, and everything else is literal.
 *
 * Grant patterns are attacker-influenced input on the authorization path, so
 * the matcher must not be built on RegExp backtracking: a pattern such as
 * `a*a*a*a*b` against a long non-matching resource made the old
 * `.*`-compiled RegExp exponential. This two-pointer form remembers only the
 * most recent `*` and re-anchors it one unit at a time, which bounds the
 * whole match at O(pattern × resource) with constant memory — the standard
 * linear-scan wildcard algorithm.
 */
const matchGlob = (pattern: string, resource: string): boolean => {
  let patternIndex = 0
  let resourceIndex = 0
  let starIndex = -1
  let starResourceIndex = 0
  while (resourceIndex < resource.length) {
    const unit = pattern[patternIndex]
    if (unit === "*") {
      starIndex = patternIndex
      starResourceIndex = resourceIndex
      patternIndex += 1
    } else if (unit !== undefined && (unit === "?" || unit === resource[resourceIndex])) {
      patternIndex += 1
      resourceIndex += 1
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      starResourceIndex += 1
      resourceIndex = starResourceIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === "*") {
    patternIndex += 1
  }
  return patternIndex === pattern.length
}

const matchesResource = (pattern: string, resource: string): boolean => {
  if (pattern.length * resource.length > maxMatchWork) {
    // A grant must never widen, so matches remains a total boolean and returns
    // false. Permission.evaluate fails closed by treating an undecidable rule
    // as a veto instead of skipping a deny that might otherwise fall through.
    return false
  }
  // A pattern ending in ` *` (`proc:spawn` command grants such as `npm *`)
  // additionally matches the bare resource without its trailing argument
  // text, exactly as the old `( .*)?` compilation did.
  if (pattern.endsWith(" *") && matchGlob(pattern.slice(0, -2), resource)) {
    return true
  }
  return matchGlob(pattern, resource)
}

/**
 * Tests whether an exact capability is selected by a pattern.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const matches = (pattern: CapabilityPattern, capability: Capability): boolean =>
  matchesAction(pattern.action, capability.action) && matchesResource(pattern.resource, capability.resource)

const actionSubsumes = (left: PatternAction, right: PatternAction): boolean => {
  if (left === "*" || left === right) {
    return true
  }
  return left.endsWith(":*") && right !== "*" && right.startsWith(left.slice(0, -1))
}

const resourceSubsumes = (left: string, right: string): boolean => {
  if (left === right || left === "**") {
    return true
  }
  if (!left.endsWith("/**")) {
    return false
  }
  const prefix = left.slice(0, -3)
  return right.startsWith(`${prefix}/`)
}

/**
 * Conservatively determines whether every capability selected by `right` is
 * also selected by `left`. It returns `false` for glob relationships that
 * cannot be proven by its syntactic checks.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const subsumes = (left: CapabilityPattern, right: CapabilityPattern): boolean =>
  actionSubsumes(left.action, right.action) && resourceSubsumes(left.resource, right.resource)

/**
 * Schema for the durability and retry semantics of an effect.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const EffectTier = Schema.Literals(["sealed", "compensable", "irreversible"] as const)

/**
 * The durability and retry semantics of an effect.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type EffectTier = typeof EffectTier.Type

const lexicalPath = (path: string): string => {
  const absolute = path.startsWith("/")
  const prefix = absolute ? "/" : ""
  const segments: Array<string> = []
  for (const segment of path.slice(prefix.length).split("/")) {
    if (segment === "" || segment === ".") {
      continue
    }
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop()
      } else if (!absolute) {
        segments.push(segment)
      }
    } else {
      segments.push(segment)
    }
  }
  return `${prefix}${segments.join("/")}` || "."
}

const isAbsolutePath = (path: string): boolean => path.startsWith("/")

const isInsideWorkspace = (resource: string, workspaceRoot: string): boolean => {
  const root = lexicalPath(workspaceRoot)
  if (root === ".") {
    return false
  }
  const resolved = lexicalPath(
    isAbsolutePath(resource) ? resource : `${root}/${resource}`
  )
  const prefix = root.endsWith("/") ? root : `${root}/`
  if (resolved === root) {
    return true
  }
  if (!resolved.startsWith(prefix)) {
    return false
  }
  // A relative root keeps its leading `..` segments, so a textual prefix match
  // is not containment: `../../x` starts with `../` yet escapes the root `..`.
  const remainder = resolved.slice(prefix.length)
  return remainder !== ".." && !remainder.startsWith("../")
}

/**
 * Options used to classify workspace-relative file writes.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface TierOptions {
  /**
   * The lexical workspace boundary used to classify file writes.
   *
   * A root that normalizes to `.` or the empty string has no lexical boundary
   * and fails closed to `irreversible`. Pass an absolute workspace root. Using
   * `.` makes every write irreversible.
   *
   * @since 0.1.0
   * @category models
   */
  readonly workspaceRoot: string
}

/**
 * Determines the effect tier for an exact capability.
 *
 * Workspace containment is lexical, so symlinks are invisible. A caller that
 * materializes workspace snapshots must resolve real paths before classifying
 * a write.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const tierOf = (capability: Capability, options: TierOptions): EffectTier => {
  switch (capability.action) {
    case "fs:read":
    case "net:get":
    case "model:call":
    case "jj:status":
    case "jj:diff":
    case "jj:root":
      return "sealed"
    case "fs:write":
      return isInsideWorkspace(capability.resource, options.workspaceRoot) ? "compensable" : "irreversible"
    case "jj:snapshot":
    case "jj:restore":
    case "jj:workspace-add":
    case "jj:workspace-forget":
    case "jj:revert":
      return "compensable"
    case "net:post":
    case "proc:spawn":
      return "irreversible"
  }
}

/**
 * Determines whether retrying an effect requires an idempotency key.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const requiresIdempotencyKey = (tier: EffectTier): boolean => tier === "irreversible"
