/**
 * The schemas the identity differential runs over.
 *
 * One list, built twice: `SchemaIdentity.test.ts` builds it from the installed
 * `effect` and projects each schema with `Node.schemaIdentity`, and
 * `fixtures/effect-rc115-schema-identity.generate.mjs` builds it from
 * `effect@4.0.0-rc.115` and records what `Schema.toJsonSchemaDocument` printed
 * there. The module therefore takes `effect/Schema` as an argument and imports
 * nothing at run time.
 *
 * It covers every check, constructor and annotation the repository's
 * declarations use, and the shapes where the 4.0.4 emitter diverged: integer
 * bounds, string lengths, patterns, repeated bounds, `oneOf` unions, record
 * keys and shared definitions. Add an entry here when a declaration starts
 * using a schema shape the list does not have, then regenerate the fixture.
 *
 * The names are the 4.0.4 ones. Six checks were renamed after rc.115; the
 * generator maps them back.
 */
import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

/** The `effect/Schema` module a corpus is built from. */
export type SchemaModule = typeof Schema

/** What the corpus needs of `effect/Effect`, from the same release as the schema module: a default is an effect. */
export type EffectModule = Pick<typeof Effect, "succeed">

/** One schema of the corpus, built on demand so a failing build is one entry's failure. */
export type Entry = () => Schema.Top

/** The 4.0.5 name of each check rc.115 exported under another name. */
export const renamedSinceRc115 = {
  isStartingWith: "isStartsWith",
  isEndingWith: "isEndsWith",
  isIncluding: "isIncludes",
  isBetweenLength: "isLengthBetween",
  isBetweenSize: "isSizeBetween",
  isBetweenProperties: "isPropertiesLengthBetween"
} as const

const registered: unique symbol = Symbol.for("@smthrs/plan/SchemaIdentityCorpus")
const local: unique symbol = Symbol("local")

export const corpus = (S: SchemaModule, E: EffectModule): Readonly<Record<string, Entry>> => {
  const entries: Record<string, Entry> = {}
  const add = (name: string, build: Entry): void => {
    entries[name] = build
  }
  const nonEmpty = (text: string): boolean => text.length > 0

  // Primitives and the built-in codecs.
  add("primitive/String", () => S.String)
  add("primitive/Number", () => S.Number)
  add("primitive/Boolean", () => S.Boolean)
  add("primitive/Null", () => S.Null)
  add("primitive/Undefined", () => S.Undefined)
  add("primitive/Void", () => S.Void)
  add("primitive/Unknown", () => S.Unknown)
  add("primitive/Any", () => S.Any)
  add("primitive/Never", () => S.Never)
  add("primitive/BigInt", () => S.BigInt)
  add("primitive/Symbol", () => S.Symbol)
  add("primitive/ObjectKeyword", () => S.ObjectKeyword)
  add("primitive/Finite", () => S.Finite)
  add("primitive/Int", () => S.Int)
  add("primitive/Natural", () => S.Natural)
  add("primitive/NonEmptyString", () => S.NonEmptyString)
  add("primitive/Char", () => S.Char)
  add("primitive/Trimmed", () => S.Trimmed)
  add("primitive/Trim", () => S.Trim)
  add("primitive/Json", () => S.Json)
  add("primitive/MutableJson", () => S.MutableJson)
  add("primitive/JsonObject", () => S.JsonObject)
  add("primitive/PropertyKey", () => S.PropertyKey)
  add("primitive/Date", () => S.Date)
  add("primitive/DateFromString", () => S.DateFromString)
  add("primitive/DateTimeUtc", () => S.DateTimeUtc)
  add("primitive/DateTimeUtcFromString", () => S.DateTimeUtcFromString)
  add("primitive/DateTimeZoned", () => S.DateTimeZoned)
  add("primitive/TimeZone", () => S.TimeZone)
  add("primitive/Duration", () => S.Duration)
  add("primitive/DurationFromMillis", () => S.DurationFromMillis)
  add("primitive/DurationFromNanos", () => S.DurationFromNanos)
  add("primitive/BigDecimal", () => S.BigDecimal)
  add("primitive/Uint8Array", () => S.Uint8Array)
  add("primitive/Uint8ArrayFromBase64", () => S.Uint8ArrayFromBase64)
  add("primitive/Uint8ArrayFromHex", () => S.Uint8ArrayFromHex)
  add("primitive/StringFromBase64", () => S.StringFromBase64)
  add("primitive/URL", () => S.URL)
  add("primitive/URLFromString", () => S.URLFromString)
  add("primitive/URLSearchParams", () => S.URLSearchParams)
  add("primitive/RegExp", () => S.RegExp)
  add("primitive/File", () => S.File)
  add("primitive/FormData", () => S.FormData)
  add("primitive/NumberFromString", () => S.NumberFromString)
  add("primitive/FiniteFromString", () => S.FiniteFromString)
  add("primitive/BooleanFromBit", () => S.BooleanFromBit)
  add("primitive/Defect", () => S.Defect())
  add("primitive/ErrorInstance", () => S.ErrorInstance())

  // Literals, enums, symbols and templates.
  add("literal/string", () => S.Literal("a"))
  add("literal/number", () => S.Literal(1))
  add("literal/boolean", () => S.Literal(true))
  add("literal/bigint", () => S.Literal(1n))
  add("literals/strings", () => S.Literals(["ready", "failed"]))
  add("literals/mixed", () => S.Literals(["a", 1, true]))
  add("literals/numbers", () => S.Literals([1, 2, 3]))
  add("literals/single", () => S.Literals(["only"]))
  add("enum/mixed", () => S.Enum({ A: "a", B: 1 }))
  add("enum/strings", () => S.Enum({ Apple: "apple", Banana: "banana" }))
  add("enum/empty", () => S.Enum({}))
  add("uniqueSymbol/registered", () => S.UniqueSymbol(registered))
  add("uniqueSymbol/local", () => S.UniqueSymbol(local))
  add("template/string", () => S.TemplateLiteral(["a-", S.String]))
  add("template/number", () => S.TemplateLiteral(["v", S.Number, ".", S.Number]))
  add("template/union", () => S.TemplateLiteral([S.Literals(["a", "b"]), "/", S.String]))
  add("template/special", () => S.TemplateLiteral(["a.b*c(", S.String, ")"]))
  add("template/nested", () => S.TemplateLiteral(["x", S.TemplateLiteral(["y", S.Number])]))
  add("template/bigint-part", () => S.TemplateLiteral(["n", S.BigInt]))
  add("template/checked", () => S.TemplateLiteral(["a-", S.String]).check(S.makeFilter(nonEmpty)))

  // String checks.
  add("check/isTrimmed", () => S.String.check(S.isTrimmed()))
  add("check/isPattern", () => S.String.check(S.isPattern(/^[a-z]+$/)))
  add("check/isPattern-u", () => S.String.check(S.isPattern(/^[a-z]+$/u)))
  add("check/isPattern-i", () => S.String.check(S.isPattern(/^[a-z]+$/i)))
  add("check/isPattern-y", () => S.String.check(S.isPattern(/[a-z]+/y)))
  add("check/isPattern-uy", () => S.String.check(S.isPattern(/[a-z]+/uy)))
  add("check/isPattern-g", () => S.String.check(S.isPattern(/[a-z]+/g)))
  add("check/isPattern-escapes", () => S.String.check(S.isPattern(/^a\/b\\dé\n$/)))
  add("check/isPattern-two", () => S.String.check(S.isPattern(/^a/), S.isPattern(/b$/)))
  add("check/isPattern-described", () => S.String.check(S.isPattern(/^a/, { description: "starts with a" })))
  add("check/isStringFinite", () => S.String.check(S.isStringFinite()))
  add("check/isStringBigInt", () => S.String.check(S.isStringBigInt()))
  add("check/isStringSymbol", () => S.String.check(S.isStringSymbol()))
  add("check/isUUID", () => S.String.check(S.isUUID()))
  add("check/isUUID-v1", () => S.String.check(S.isUUID(1)))
  add("check/isUUID-v4", () => S.String.check(S.isUUID(4)))
  add("check/isUUID-v7", () => S.String.check(S.isUUID(7)))
  add("check/isUUID-v8", () => S.String.check(S.isUUID(8)))
  add("check/isGUID", () => S.String.check(S.isGUID()))
  add("check/isULID", () => S.String.check(S.isULID()))
  add("check/isBase64", () => S.String.check(S.isBase64()))
  add("check/isBase64Url", () => S.String.check(S.isBase64Url()))
  add("check/isStartingWith", () => S.String.check(S.isStartingWith("pre.fix")))
  add("check/isStartingWith-empty", () => S.String.check(S.isStartingWith("")))
  add("check/isStartingWith-surrogate", () => S.String.check(S.isStartingWith("a\ud83d")))
  add("check/isStartingWith-newline", () => S.String.check(S.isStartingWith("a\nb/c")))
  add("check/isEndingWith", () => S.String.check(S.isEndingWith("suf(fix)")))
  add("check/isEndingWith-surrogate", () => S.String.check(S.isEndingWith("\ude00a")))
  add("check/isIncluding", () => S.String.check(S.isIncluding("mid[dle]")))
  add("check/isIncluding-empty", () => S.String.check(S.isIncluding("")))
  add("check/isIncluding-surrogate", () => S.String.check(S.isIncluding("\ude00a\ud83d")))
  add("check/isUppercased", () => S.String.check(S.isUppercased()))
  add("check/isLowercased", () => S.String.check(S.isLowercased()))
  add("check/isCapitalized", () => S.String.check(S.isCapitalized()))
  add("check/isUncapitalized", () => S.String.check(S.isUncapitalized()))
  for (const size of [0, 1, 2, 3, 5, 2.7, -1]) {
    add(`check/isMinLength-${size}`, () => S.String.check(S.isMinLength(size)))
    add(`check/isMaxLength-${size}`, () => S.String.check(S.isMaxLength(size)))
  }
  add("check/isNonEmpty", () => S.String.check(S.isNonEmpty()))
  add("check/isBetweenLength", () => S.String.check(S.isBetweenLength(2, 5)))
  add("check/isBetweenLength-equal", () => S.String.check(S.isBetweenLength(3, 3)))
  add("check/isBetweenLength-zero", () => S.String.check(S.isBetweenLength(0, 0)))
  add("check/length-stack", () => S.String.check(S.isMinLength(2), S.isMaxLength(5)))
  add("check/length-stack-repeat", () => S.String.check(S.isMinLength(2), S.isMinLength(4)))
  add("check/length-stack-chain", () => S.String.check(S.isMinLength(2)).check(S.isMaxLength(5)))
  add(
    "check/length-pattern",
    () => S.String.check(S.isMinLength(1), S.isMaxLength(64), S.isPattern(/^[a-z][a-z0-9-]*$/))
  )
  add("check/nonEmptyString-pattern", () => S.NonEmptyString.check(S.isPattern(/^[a-z]+$/)))
  add("check/nonEmptyString-max", () => S.NonEmptyString.check(S.isMaxLength(200)))
  add("check/nonEmptyString-trimmed", () => S.NonEmptyString.check(S.isTrimmed()))

  // Number checks. `Number` encodes through a codec, so a bound shows on `Finite` and `Int`.
  add("check/isFinite", () => S.Number.check(S.isFinite()))
  add("check/isInt", () => S.Number.check(S.isInt()))
  add("check/isInt32", () => S.Number.check(S.isInt32()))
  add("check/isUint32", () => S.Number.check(S.isUint32()))
  add("check/number-bound", () => S.Number.check(S.isGreaterThan(0)))
  add("check/finite-gt", () => S.Finite.check(S.isGreaterThan(0)))
  add("check/finite-gte", () => S.Finite.check(S.isGreaterThanOrEqualTo(0)))
  add("check/finite-lt", () => S.Finite.check(S.isLessThan(10)))
  add("check/finite-lte", () => S.Finite.check(S.isLessThanOrEqualTo(10)))
  add("check/finite-between", () => S.Finite.check(S.isBetween({ minimum: 0, maximum: 1 })))
  add(
    "check/finite-between-exclusive",
    () => S.Finite.check(S.isBetween({ minimum: 1, maximum: 5, exclusiveMinimum: true, exclusiveMaximum: true }))
  )
  add(
    "check/finite-between-half",
    () => S.Finite.check(S.isBetween({ minimum: 1, maximum: 5, exclusiveMaximum: true }))
  )
  add("check/finite-multiple", () => S.Finite.check(S.isMultipleOf(0.5)))
  add("check/finite-int", () => S.Finite.check(S.isInt()))
  add("check/finite-min-repeat", () => S.Finite.check(S.isGreaterThanOrEqualTo(0), S.isGreaterThanOrEqualTo(5)))
  add("check/finite-min-exclusive", () => S.Finite.check(S.isGreaterThanOrEqualTo(0), S.isGreaterThan(0)))
  add(
    "check/finite-max-repeat",
    () => S.Finite.check(S.isLessThanOrEqualTo(9), S.isLessThanOrEqualTo(5), S.isLessThan(5))
  )
  add("check/int-min", () => S.Int.check(S.isGreaterThanOrEqualTo(0)))
  add("check/int-min1", () => S.Int.check(S.isGreaterThanOrEqualTo(1)))
  add("check/int-gt", () => S.Int.check(S.isGreaterThan(0)))
  add("check/int-max", () => S.Int.check(S.isLessThanOrEqualTo(100)))
  add("check/int-lt", () => S.Int.check(S.isLessThan(100)))
  add("check/int-between", () => S.Int.check(S.isBetween({ minimum: 1, maximum: 65535 })))
  add("check/int-min-max", () => S.Int.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(10)))
  add("check/int-min-max-chain", () => S.Int.check(S.isGreaterThanOrEqualTo(1)).check(S.isLessThanOrEqualTo(10)))
  add("check/int-multiple", () => S.Int.check(S.isMultipleOf(2)))
  add("check/number-int-int", () => S.Number.check(S.isInt(), S.isInt()))
  add("check/number-finite-int", () => S.Number.check(S.isFinite(), S.isInt()))
  add("check/number-int-finite", () => S.Number.check(S.isInt(), S.isFinite()))
  add("check/numberFromString-int", () => S.NumberFromString.check(S.isInt(), S.isGreaterThan(0)))

  // Checks whose subject encodes through a codec print nothing; on `Any` they are kept.
  add("check/date", () => S.Date.check(S.isGreaterThanDate(new Date(0))))
  add("check/bigint", () => S.BigInt.check(S.isGreaterThanBigInt(0n)))
  add("check/any-date-gt", () => S.Any.check(S.isGreaterThanDate(new Date(0), { description: "after the epoch" })))
  add("check/any-date-gte", () => S.Any.check(S.isGreaterThanOrEqualToDate(new Date(0), { title: "Since" })))
  add("check/any-date-lt", () => S.Any.check(S.isLessThanDate(new Date(0), { description: "before the epoch" })))
  add("check/any-date-lte", () => S.Any.check(S.isLessThanOrEqualToDate(new Date(0), { title: "Until" })))
  add(
    "check/any-date-between",
    () => S.Any.check(S.isBetweenDate({ minimum: new Date(0), maximum: new Date(1000) }, { description: "a window" }))
  )
  add("check/any-bigint-gt", () => S.Any.check(S.isGreaterThanBigInt(0n, { description: "positive" })))
  add("check/any-bigint-gte", () => S.Any.check(S.isGreaterThanOrEqualToBigInt(0n, { title: "Natural" })))
  add("check/any-bigint-lt", () => S.Any.check(S.isLessThanBigInt(0n, { description: "negative" })))
  add("check/any-bigint-lte", () => S.Any.check(S.isLessThanOrEqualToBigInt(0n, { title: "NonPositive" })))
  add(
    "check/any-bigint-between",
    () => S.Any.check(S.isBetweenBigInt({ minimum: 0n, maximum: 9n }, { description: "a digit" }))
  )
  add("check/any-minSize", () => S.Any.check(S.isMinSize(1, { description: "not empty" })))
  add("check/any-maxSize", () => S.Any.check(S.isMaxSize(3, { title: "Small" })))
  add("check/any-betweenSize", () => S.Any.check(S.isBetweenSize(1, 3, { description: "a few" })))
  add("check/any-size-plain", () => S.Any.check(S.isMinSize(1), S.isMaxSize(3)))
  add("check/any-uniqueKey", () => S.Any.check(S.isUniqueKey({ description: "unique keys" })))
  add("check/any-minLength", () => S.Any.check(S.isMinLength(1), S.isMaxLength(4)))
  add("check/any-betweenLength", () => S.Any.check(S.isBetweenLength(1, 4)))
  add("check/any-minProperties", () => S.Any.check(S.isMinProperties(1), S.isMaxProperties(4)))
  add("check/any-int", () => S.Any.check(S.isInt()))

  // Collection checks.
  add("check/array-min", () => S.Array(S.String).check(S.isMinLength(1)))
  add("check/array-max", () => S.Array(S.String).check(S.isMaxLength(3)))
  add("check/array-min-max", () => S.Array(S.String).check(S.isMinLength(1), S.isMaxLength(3)))
  add("check/array-between", () => S.Array(S.String).check(S.isBetweenLength(1, 3)))
  add("check/array-unique", () => S.Array(S.String).check(S.isUnique()))
  add("check/array-nonEmpty", () => S.Array(S.String).check(S.isNonEmpty()))
  add("check/array-uniqueArray", () => S.UniqueArray(S.String))
  add("check/tuple-min", () => S.Tuple([S.String, S.String]).check(S.isMinLength(1)))
  add("check/tuple-max", () => S.Tuple([S.String, S.String]).check(S.isMaxLength(2)))
  add("check/union-min", () => S.Union([S.String, S.Array(S.String)]).check(S.isMinLength(1), S.isMaxLength(4)))
  add("check/union-between", () => S.Union([S.String, S.Array(S.String)]).check(S.isBetweenLength(1, 4)))
  add("check/record-minProperties", () => S.Record(S.String, S.Finite).check(S.isMinProperties(1)))
  add("check/record-maxProperties", () => S.Record(S.String, S.Finite).check(S.isMaxProperties(3)))
  add("check/record-betweenProperties", () => S.Record(S.String, S.Finite).check(S.isBetweenProperties(1, 3)))
  add(
    "check/record-propertyNames",
    () => S.Record(S.String, S.Finite).check(S.isPropertyNames(S.String.check(S.isMinLength(2))))
  )
  add(
    "check/record-propertyNames-ref",
    () => S.Record(S.String, S.Finite).check(S.isPropertyNames(S.String.annotate({ identifier: "Key" })))
  )
  for (
    const [name, key] of Object.entries({
      bigint: S.BigInt,
      symbol: S.Symbol,
      undefined: S.Undefined,
      void: S.Void,
      object: S.ObjectKeyword,
      never: S.Never,
      number: S.Number,
      boolean: S.Boolean,
      unknown: S.Unknown,
      "unique-registered": S.UniqueSymbol(registered),
      "unique-local": S.UniqueSymbol(local),
      "literal-bigint": S.Literal(1n),
      "literal-number": S.Literal(1),
      enum: S.Enum({ A: "a", B: 1 }),
      template: S.TemplateLiteral(["k-", S.String]),
      suspended: S.suspend(() => S.String).annotate({ description: "later" }),
      declaration: S.Date
    })
  ) {
    add(`check/record-propertyNames-${name}`, () => S.Record(S.String, S.Finite).check(S.isPropertyNames(key)))
  }
  add(
    "check/struct-minProperties",
    () => S.Struct({ a: S.optionalKey(S.String), b: S.optionalKey(S.String) }).check(S.isMinProperties(1))
  )

  // Author-written checks.
  add("check/makeFilter", () => S.String.check(S.makeFilter(nonEmpty)))
  add(
    "check/makeFilter-described",
    () => S.String.check(S.makeFilter(nonEmpty, { description: "non empty", title: "NonEmpty" }))
  )
  add("check/makeFilter-expected", () => S.String.check(S.makeFilter(nonEmpty, { expected: "a non-empty string" })))
  add(
    "check/makeFilter-toJsonSchema",
    () => S.String.check(S.makeFilter(nonEmpty, { toJsonSchema: () => ({ minLength: 1 }) }))
  )
  add(
    "check/makeFilter-toJsonSchema-described",
    () => S.String.check(S.makeFilter(nonEmpty, { toJsonSchema: () => ({ minLength: 1 }), description: "non empty" }))
  )
  add(
    "check/makeFilter-toJsonSchema-format",
    () => S.String.check(S.makeFilter(nonEmpty, { toJsonSchema: () => ({ minLength: 1 }), format: "email" }))
  )
  add(
    "check/makeFilter-toJsonSchema-anyOf",
    () =>
      S.String.check(S.makeFilter(nonEmpty, { toJsonSchema: () => ({ anyOf: [{ minLength: 1 }, { maxLength: 0 }] }) }))
  )
  add(
    "check/makeFilter-toJsonSchema-type",
    () => S.Any.check(S.makeFilter(() => true, { toJsonSchema: ({ type }) => ({ description: String(type) }) }))
  )
  add(
    "check/makeFilter-toJsonSchema-sees-type",
    () =>
      S.Any.check(
        S.makeFilter(() => true, { toJsonSchema: () => ({ type: "tensor" }) }),
        S.makeFilter(() => true, { toJsonSchema: ({ type }) => ({ description: String(type) }) }),
        S.makeFilter(() => true, { toJsonSchema: () => ({ type: "string" }) }),
        S.makeFilter(() => true, { toJsonSchema: ({ type }) => ({ title: String(type) }) })
      )
  )
  add(
    "check/makeFilter-toJsonSchema-throws",
    () =>
      S.String.check(S.makeFilter(nonEmpty, {
        toJsonSchema: () => {
          throw new Error("no JSON Schema representation")
        }
      }))
  )
  add("check/makeFilter-after-builtin", () => S.String.check(S.isMinLength(1), S.makeFilter(nonEmpty)))
  add("check/makeFilterGroup", () => S.String.check(S.makeFilterGroup([S.isMinLength(1), S.isMaxLength(5)])))
  add(
    "check/makeFilterGroup-annotated",
    () =>
      S.String.check(
        S.makeFilterGroup([S.isMinLength(1), S.isMaxLength(5)], { description: "bounded", title: "Bounded" })
      )
  )
  add(
    "check/makeFilterGroup-renamed",
    () => S.String.check(S.makeFilterGroup([S.isBetweenLength(1, 3), S.isIncluding("a")]), S.isEndingWith("z"))
  )
  add(
    "check/record-renamed-key-check",
    () =>
      S.Record(S.String, S.Finite).check(
        S.isPropertyNames(S.String.check(S.isStartingWith("x-"))),
        S.isBetweenProperties(1, 3)
      )
  )
  add("check/renamed-size", () => S.ReadonlySet(S.String).check(S.isBetweenSize(1, 2)))
  add("ref/renamed-check", () => {
    const Prefixed = S.String.check(S.isStartingWith("p-")).annotate({ identifier: "Prefixed" })
    return S.Struct({ a: Prefixed, b: Prefixed })
  })
  add("check/makeFilterGroup-silent", () => S.String.check(S.makeFilterGroup([S.makeFilter(nonEmpty)])))
  add(
    "check/makeFilterGroup-toJsonSchema",
    () =>
      S.String.check(
        S.makeFilterGroup([S.isMinLength(1), S.isMaxLength(5)], { toJsonSchema: () => ({ minLength: 1 }) })
      )
  )
  add(
    "check/makeFilterGroup-nested",
    () => S.Finite.check(S.makeFilterGroup([S.isInt(), S.makeFilterGroup([S.isGreaterThan(0), S.isLessThan(9)])]))
  )
  add("check/makeFilterGroup-int-finite", () => S.Number.check(S.makeFilterGroup([S.isInt(), S.isFinite()])))
  add("check/makeFilterGroup-finite-int", () => S.Number.check(S.makeFilterGroup([S.isFinite(), S.isInt()])))
  add(
    "check/makeFilter-toJsonSchema-empty",
    () => S.String.check(S.makeFilter(nonEmpty, { toJsonSchema: () => ({}) }))
  )
  add("check/refine", () => S.String.pipe(S.refine((text: string): text is string => text.length > 0)))
  add("check/annotate-after", () => S.String.check(S.isMinLength(1)).annotate({ description: "a name", title: "Name" }))
  add("check/annotate-before", () => S.String.annotate({ description: "a name" }).check(S.isMinLength(1)))
  add(
    "check/annotate-both",
    () => S.String.annotate({ description: "base" }).check(S.isMinLength(1)).annotate({ description: "checked" })
  )
  add("check/annotate-format", () => S.String.check(S.isMinLength(1)).annotate({ format: "email" }))
  add(
    "check/annotate-default",
    () => S.Int.check(S.isGreaterThanOrEqualTo(0)).annotate({ default: 3, examples: [1, 2] })
  )
  add(
    "check/builtin-described",
    () => S.String.check(S.isMinLength(2, { description: "at least two", title: "Two" }))
  )
  add("check/builtin-format", () => S.String.check(S.isMinLength(2, { format: "x" })))
  add("check/int-described", () => S.Int.annotate({ description: "count" }))
  add("check/nonEmptyString-described", () => S.NonEmptyString.annotate({ description: "name" }))

  // Annotations.
  add("annotate/title", () => S.String.annotate({ title: "T" }))
  add("annotate/description", () => S.String.annotate({ description: "D" }))
  add("annotate/default", () => S.String.annotate({ default: "x" }))
  add("annotate/default-null", () => S.NullOr(S.String).annotate({ default: null }))
  add("annotate/default-object", () => S.Unknown.annotate({ default: { a: [1, "b", null, true] } }))
  add("annotate/examples", () => S.String.annotate({ examples: ["a", "b"] }))
  add("annotate/readOnly", () => S.String.annotate({ readOnly: true }))
  add("annotate/writeOnly", () => S.String.annotate({ writeOnly: true }))
  add("annotate/format", () => S.String.annotate({ format: "date-time" }))
  add(
    "annotate/content",
    () =>
      S.String.annotate({
        contentEncoding: "base64",
        contentMediaType: "application/json",
        contentSchema: { type: "object", properties: { a: { $ref: "#/$defs/Name" } } }
      })
  )
  add(
    "annotate/all",
    () =>
      S.String.annotate({
        format: "f",
        writeOnly: false,
        readOnly: true,
        examples: ["a"],
        default: "x",
        description: "D",
        title: "T"
      })
  )
  add("annotate/identifier", () => S.String.annotate({ identifier: "Name" }))
  add("annotate/unlisted-keys", () => S.String.annotate({ custom: "ignored", documentation: "doc", expected: "x" }))
  add("annotate/not-json", () => S.Any.annotate({ default: new Date(0), examples: [new Map()] }))
  add("annotate/not-json-number", () => S.Finite.annotate({ default: Number.NaN, examples: [1, Number.NaN] }))
  add("annotate/not-json-cycle", () => {
    const loop: { self?: unknown } = {}
    loop.self = loop
    return S.Any.annotate({ default: loop })
  })
  add("annotate/not-json-sparse", () => S.Any.annotate({ default: new Array<number>(2) }))
  add("annotate/json-shared", () => {
    const shared = { a: 1 }
    return S.Any.annotate({ default: [shared, shared, Object.assign(Object.create(null), { b: shared })] })
  })
  add("annotate/check-shaped-data", () => {
    // Data an author wrote that looks like an encoded renamed check. It is
    // data, so no identity may rewrite it.
    const data = {
      checks: [{
        _tag: "Filter",
        representation: { id: "effect/schema/isStartingWith", payload: null },
        aborted: false
      }]
    }
    return S.Unknown.annotate({ examples: [data], default: data, custom: data })
  })
  add("annotate/number", () => S.Number.annotate({ description: "n" }))
  add("annotate/struct", () => S.Struct({ a: S.String }).annotate({ description: "a struct", title: "A" }))
  add("annotate/key", () => S.Struct({ a: S.String.annotateKey({ description: "key a", title: "A" }) }))
  add(
    "annotate/key-and-value",
    () => S.Struct({ a: S.String.annotate({ description: "value" }).annotateKey({ description: "key" }) })
  )
  add(
    "annotate/key-optional",
    () => S.Struct({ a: S.optionalKey(S.String).annotateKey({ description: "key a" }) })
  )
  add("annotate/key-number", () => S.Struct({ a: S.Number.annotateKey({ description: "key n" }) }))
  add("annotate/key-int", () => S.Struct({ a: S.Int.annotateKey({ description: "key int" }) }))
  add("annotate/key-format", () => S.Struct({ a: S.String.annotateKey({ format: "email" }) }))
  add("annotate/key-ref", () => {
    const Name = S.String.annotate({ identifier: "Name" })
    return S.Struct({ a: Name.annotateKey({ description: "key ref" }), b: Name })
  })
  add(
    "annotate/key-allOf",
    () => S.Struct({ a: S.String.check(S.isMinLength(1), S.isMinLength(2)).annotateKey({ format: "x" }) })
  )
  add("annotate/tuple-element", () => S.Tuple([S.String.annotateKey({ description: "first" }), S.Number]))
  add("annotate/union", () => S.Union([S.String, S.Number]).annotate({ description: "either" }))
  add("annotate/array", () => S.Array(S.String).annotate({ description: "names" }))

  // Structs.
  add("struct/empty", () => S.Struct({}))
  add("struct/basic", () => S.Struct({ name: S.String, count: S.Number }))
  add("struct/optionalKey", () => S.Struct({ name: S.optionalKey(S.String), items: S.Array(S.Boolean) }))
  add("struct/optional", () => S.Struct({ name: S.optional(S.String) }))
  add("struct/all-optional", () => S.Struct({ a: S.optionalKey(S.String), b: S.optional(S.Number) }))
  add("struct/mutableKey", () => S.Struct({ name: S.mutableKey(S.String) }))
  add("struct/nullOr", () => S.Struct({ name: S.NullOr(S.String) }))
  add("struct/undefinedOr", () => S.Struct({ name: S.UndefinedOr(S.String) }))
  add("struct/nullishOr", () => S.Struct({ name: S.NullishOr(S.String) }))
  add("struct/nested", () => S.Struct({ a: S.Struct({ b: S.Struct({ c: S.Int }) }) }))
  add(
    "struct/odd-keys",
    () => S.Struct({ "a/b": S.String, "~c": S.String, "$ref": S.String, ["__proto__"]: S.String, "": S.String })
  )
  add("struct/symbol-key", () => S.Struct({ [registered]: S.String }))
  add(
    "struct/withConstructorDefault",
    () => S.Struct({ a: S.String.pipe(S.withConstructorDefault(E.succeed("x"))) })
  )
  add("struct/withDecodingDefault", () => S.Struct({ a: S.String.pipe(S.withDecodingDefault(E.succeed("x"))) }))
  add(
    "struct/withDecodingDefaultKey",
    () => S.Struct({ a: S.String.pipe(S.withDecodingDefaultKey(E.succeed("x"))) })
  )
  add("struct/unknown-fields", () => S.Struct({ a: S.Unknown, b: S.Any }))
  add("struct/null-fields", () => S.Struct({ a: S.Void, b: S.Undefined, c: S.Null, d: S.Never }))
  add("struct/tagged", () => S.TaggedStruct("Ready", { value: S.String }))
  add("struct/tag", () => S.Struct({ kind: S.tag("k"), v: S.Int }))
  add(
    "struct/declaration-shaped",
    () =>
      S.Struct({
        id: S.NonEmptyString,
        attempt: S.Int.check(S.isGreaterThanOrEqualTo(1)),
        labels: S.Array(S.NonEmptyString),
        status: S.Literals(["queued", "running", "done"]),
        note: S.optional(S.String),
        parent: S.NullOr(S.NonEmptyString),
        budget: S.optionalKey(S.Finite.check(S.isGreaterThan(0))),
        meta: S.Record(S.String, S.Unknown),
        payload: S.Json
      })
  )

  // Records and index signatures.
  add("record/string", () => S.Record(S.String, S.String))
  add("record/number-value", () => S.Record(S.String, S.Number))
  add("record/unknown", () => S.Record(S.String, S.Unknown))
  add("record/never", () => S.Record(S.String, S.Never))
  add("record/literals", () => S.Record(S.Literals(["a", "b"]), S.Finite))
  add("record/template", () => S.Record(S.TemplateLiteral(["k-", S.String]), S.Finite))
  add(
    "record/template-checked",
    () => S.Record(S.TemplateLiteral(["k-", S.String]).check(S.makeFilter(nonEmpty)), S.Finite)
  )
  add("record/pattern-key", () => S.Record(S.String.check(S.isPattern(/^[a-z]+$/)), S.Finite))
  add(
    "record/pattern-key-described",
    () => S.Record(S.String.check(S.isPattern(/^[a-z]+$/, { description: "lower" })), S.Finite)
  )
  add("record/minLength-key", () => S.Record(S.String.check(S.isMinLength(1)), S.Finite))
  add("record/nonEmpty-key", () => S.Record(S.NonEmptyString, S.Finite))
  add("record/two-check-key", () => S.Record(S.String.check(S.isMinLength(1), S.isMaxLength(3)), S.Finite))
  add("record/group-key", () => S.Record(S.String.check(S.makeFilterGroup([S.isPattern(/^a/)])), S.Finite))
  add("record/custom-key", () => S.Record(S.String.check(S.makeFilter(nonEmpty)), S.Finite))
  add("record/custom-key-titled", () => S.Record(S.String.check(S.makeFilter(nonEmpty, { title: "k" })), S.Finite))
  add("record/uuid-key", () => S.Record(S.String.check(S.isUUID()), S.Finite))
  add("record/startingWith-key", () => S.Record(S.String.check(S.isStartingWith("x-")), S.Finite))
  add("record/uppercased-key", () => S.Record(S.String.check(S.isUppercased()), S.Finite))
  add(
    "record/union-key",
    () => S.Record(S.Union([S.TemplateLiteral(["a-", S.String]), S.TemplateLiteral(["b-", S.String])]), S.Finite)
  )
  add(
    "record/union-key-string",
    () => S.Record(S.Union([S.TemplateLiteral(["a-", S.String]), S.String]), S.Finite)
  )
  add(
    "record/union-key-custom",
    () => S.Record(S.Union([S.TemplateLiteral(["a-", S.String]), S.String.check(S.makeFilter(nonEmpty))]), S.Finite)
  )
  add(
    "record/union-key-oneOf",
    () =>
      S.Record(
        S.Union([S.TemplateLiteral(["a-", S.String]), S.TemplateLiteral(["b-", S.String])], { mode: "oneOf" }),
        S.Finite
      )
  )
  add(
    "record/ref-key",
    () => S.Record(S.String.check(S.isPattern(/^[a-z]+$/)).annotate({ identifier: "Key" }), S.Finite)
  )
  add("record/ref-key-plain", () => S.Record(S.String.annotate({ identifier: "Key" }), S.Finite))
  add("record/number-key", () => S.Record(S.Number, S.String))
  add("record/symbol-key", () => S.Record(S.Symbol, S.String))
  add("record/struct-value", () => S.Record(S.String, S.Struct({ a: S.Int })))
  add("record/nested", () => S.Record(S.String, S.Record(S.String, S.Array(S.String))))
  add("structWithRest/string", () => S.StructWithRest(S.Struct({ a: S.String }), [S.Record(S.String, S.Finite)]))
  add(
    "structWithRest/template",
    () => S.StructWithRest(S.Struct({ a: S.String }), [S.Record(S.TemplateLiteral(["x-", S.String]), S.Finite)])
  )
  add(
    "structWithRest/two",
    () =>
      S.StructWithRest(S.Struct({ a: S.String }), [
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Finite),
        S.Record(S.TemplateLiteral(["y-", S.String]), S.Boolean)
      ])
  )
  add(
    "structWithRest/same-pattern",
    () =>
      S.StructWithRest(S.Struct({ a: S.String }), [
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Finite),
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Int)
      ])
  )
  add(
    "structWithRest/same-pattern-never",
    () =>
      S.StructWithRest(S.Struct({ a: S.String }), [
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Finite),
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Never)
      ])
  )
  add(
    "structWithRest/custom",
    () => S.StructWithRest(S.Struct({ a: S.String }), [S.Record(S.String.check(S.makeFilter(nonEmpty)), S.Finite)])
  )
  add(
    "structWithRest/custom-and-string",
    () =>
      S.StructWithRest(S.Struct({ a: S.String }), [
        S.Record(S.String.check(S.makeFilter(nonEmpty)), S.Finite),
        S.Record(S.String, S.Unknown)
      ])
  )
  add(
    "structWithRest/custom-twice",
    () =>
      S.StructWithRest(S.Struct({}), [
        S.Record(S.String.check(S.makeFilter(nonEmpty)), S.Finite),
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Boolean)
      ])
  )
  add(
    "structWithRest/template-and-string",
    () =>
      S.StructWithRest(S.Struct({ a: S.String }), [
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Finite),
        S.Record(S.String, S.Unknown)
      ])
  )
  add(
    "structWithRest/empty-struct",
    () =>
      S.StructWithRest(S.Struct({}), [
        S.Record(S.TemplateLiteral(["x-", S.String]), S.Finite),
        S.Record(S.String, S.Boolean)
      ])
  )
  add(
    "structWithRest/two-strings",
    () => S.StructWithRest(S.Struct({}), [S.Record(S.String, S.Finite), S.Record(S.String, S.Boolean)])
  )

  // Arrays and tuples.
  add("array/string", () => S.Array(S.String))
  add("array/unknown", () => S.Array(S.Unknown))
  add("array/number", () => S.Array(S.Number))
  add("array/struct", () => S.Array(S.Struct({ a: S.Int })))
  add("array/nonEmpty", () => S.NonEmptyArray(S.String))
  add("array/nested", () => S.Array(S.Array(S.Int)))
  add("array/mutable", () => S.mutable(S.Array(S.String)))
  add("tuple/empty", () => S.Tuple([]))
  add("tuple/basic", () => S.Tuple([S.String, S.Number]))
  add("tuple/optional", () => S.Tuple([S.String, S.optionalKey(S.Number)]))
  add("tuple/all-optional", () => S.Tuple([S.optionalKey(S.String), S.optionalKey(S.Number)]))
  add("tuple/rest", () => S.TupleWithRest(S.Tuple([S.String]), [S.Number]))
  add("tuple/rest-unknown", () => S.TupleWithRest(S.Tuple([S.String]), [S.Unknown]))
  add("tuple/rest-only", () => S.TupleWithRest(S.Tuple([]), [S.Unknown]))
  add("tuple/rest-then-element", () => S.TupleWithRest(S.Tuple([S.String]), [S.Number, S.Boolean]))

  // Unions.
  add("union/empty", () => S.Union([]))
  add("union/single", () => S.Union([S.String]))
  add("union/basic", () => S.Struct({ value: S.Union([S.String, S.Number]) }))
  add("union/literal-members", () => S.Union([S.Literal("a"), S.Literal("b")]))
  add("union/literal-duplicate", () => S.Union([S.Literal("a"), S.Literal("a")]))
  add("union/literal-described", () => S.Union([S.Literal("a").annotate({ description: "A" }), S.Literal("b")]))
  add("union/literal-mixed", () => S.Union([S.Literal("a"), S.Literal(1)]))
  add("union/oneOf", () => S.Union([S.String, S.Finite], { mode: "oneOf" }))
  add("union/oneOf-literals", () => S.Union([S.Literal("a"), S.Literal("b")], { mode: "oneOf" }))
  add(
    "union/oneOf-structs",
    () => S.Union([S.Struct({ a: S.String }), S.Struct({ b: S.Finite })], { mode: "oneOf" })
  )
  add(
    "union/oneOf-custom",
    () => S.Union([S.String.check(S.makeFilter(nonEmpty)), S.Finite], { mode: "oneOf" })
  )
  add("union/oneOf-length", () => S.Union([S.String.check(S.isMinLength(3)), S.Finite], { mode: "oneOf" }))
  add("union/oneOf-declaration", () => S.Union([S.String, S.Json], { mode: "oneOf" }))
  add(
    "union/oneOf-key",
    () => S.Struct({ a: S.Union([S.String, S.Int], { mode: "oneOf" }).annotateKey({ description: "k" }) })
  )
  add(
    "union/oneOf-ref",
    () => {
      const Text = S.String.check(S.isPattern(/^a/)).annotate({ identifier: "Text" })
      return S.Struct({ a: S.Union([Text, S.Finite], { mode: "oneOf" }), b: Text })
    }
  )
  add(
    "union/tagged",
    () =>
      S.Union([
        S.Struct({ _tag: S.Literal("Ready"), value: S.String }),
        S.Struct({ _tag: S.Literal("Failed"), code: S.Int })
      ])
  )
  add(
    "union/taggedStructs",
    () => S.Union([S.TaggedStruct("A", { a: S.String }), S.TaggedStruct("B", { b: S.Int })])
  )
  add("union/taggedUnion", () => S.TaggedUnion({ A: { a: S.String }, B: { b: S.Int } }))
  add("union/nullOr", () => S.NullOr(S.String))
  add("union/nullOr-struct", () => S.NullOr(S.Struct({ a: S.String })))
  add("union/codec-order", () => S.Union([S.String, S.BigInt, S.Number, S.Symbol]))
  add("union/nested", () => S.Union([S.Union([S.Literal("a"), S.Literal("b")]), S.Literal("c")]))
  add(
    "union/number-first-checked",
    () => S.Union([S.Finite, S.Boolean]).check(S.makeFilter(() => true, { toJsonSchema: () => ({ title: "x" }) }))
  )
  add(
    "union/number-first-typed",
    () => S.Union([S.Finite, S.String]).check(S.makeFilter(() => true, { toJsonSchema: () => ({ type: "integer" }) }))
  )
  add(
    "union/checked",
    () => S.Union([S.String, S.Finite]).check(S.makeFilter(() => true, { toJsonSchema: () => ({ title: "x" }) }))
  )

  // Definitions: identifiers, reuse and recursion.
  add("ref/single-use", () => S.Struct({ a: S.String.annotate({ identifier: "Name" }) }))
  add("ref/reuse", () => {
    const Name = S.String.annotate({ identifier: "Name" })
    return S.Struct({ a: Name, b: Name, c: S.Array(Name) })
  })
  add(
    "ref/same-identifier-different",
    () => S.Struct({ a: S.String.annotate({ identifier: "X" }), b: S.Number.annotate({ identifier: "X" }) })
  )
  add(
    "ref/same-identifier-equal",
    () => S.Struct({ a: S.String.annotate({ identifier: "X" }), b: S.String.annotate({ identifier: "X" }) })
  )
  add("ref/root", () => S.Struct({ a: S.String }).annotate({ identifier: "Root" }))
  add("ref/odd-identifier", () => S.Struct({ a: S.String.annotate({ identifier: "a/b~c d%#" }) }))
  add("ref/surrogate-identifier", () => S.Struct({ a: S.String.annotate({ identifier: "a\ud83d" }) }))
  add("ref/prototype-identifier", () => S.Struct({ a: S.String.annotate({ identifier: "__proto__" }) }))
  add("ref/struct-reuse", () => {
    const Point = S.Struct({ x: S.Int, y: S.Int }).annotate({ identifier: "Point" })
    return S.Struct({ from: Point, to: Point })
  })
  add("ref/checked-identifier", () => {
    const Name = S.String.check(S.isMinLength(1)).annotate({ identifier: "Name", description: "a name" })
    return S.Struct({ a: Name, b: Name })
  })
  add("ref/optional-reuse", () => {
    const Name = S.String.annotate({ identifier: "Name" })
    return S.Struct({ a: Name, b: S.optionalKey(Name), c: S.optional(Name) })
  })
  add("ref/nullOr-reuse", () => {
    const Name = S.String.annotate({ identifier: "Name" })
    return S.Struct({ a: S.NullOr(Name), b: S.NullOr(Name) })
  })
  add("ref/described-use", () => {
    const Name = S.String.annotate({ identifier: "Name" })
    return S.Struct({ a: Name.annotate({ description: "first" }), b: Name })
  })
  add("ref/checked-use", () => {
    const Name = S.String.annotate({ identifier: "Name" })
    return S.Struct({ a: Name.check(S.isMinLength(1)), b: Name })
  })
  add("ref/content-schema", () =>
    S.Struct({
      a: S.String.annotate({ identifier: "Name" }),
      b: S.String.annotate({ contentSchema: { $ref: "#/$defs/Name", $dynamicRef: "#meta", enum: [{ $ref: "#/x" }] } })
    }))
  add("ref/content-schema-malformed", () => S.String.annotate({ contentSchema: { $ref: "#/~2" } }))
  add("ref/content-schema-unencoded", () => S.String.annotate({ contentSchema: { $ref: "#a b" } }))
  add("ref/content-schema-unencoded-pointer", () => S.String.annotate({ contentSchema: { $ref: "#/a b" } }))
  add("ref/content-schema-shapes", () =>
    S.Struct({
      a: S.String.annotate({ identifier: "Name" }),
      b: S.String.annotate({
        contentSchema: {
          $defs: { Local: { $ref: "" } },
          properties: 1,
          patternProperties: { "^x": { $ref: "#" } },
          dependentSchemas: { a: { $ref: "other.json#/x" } },
          allOf: 2,
          anyOf: [{ $ref: "#%zz" }, 3],
          oneOf: [{ $ref: "#/properties/a" }],
          prefixItems: [{ $ref: "#/$defs/Name/properties/x" }],
          not: { $ref: "#/$defs/Missing" },
          additionalProperties: false,
          propertyNames: { $dynamicRef: "#/$defs/Name" },
          unevaluatedProperties: { $ref: "#/$defs/Name" },
          items: [{ $ref: "#/$defs/Name" }],
          contains: null,
          unevaluatedItems: { const: { $ref: "#/not-walked" } },
          if: { $ref: "#%2F$defs%2FName" },
          then: { $ref: "#/$defs/a~1b" },
          else: { default: { $ref: "#/not-walked" } },
          contentSchema: { $ref: "#/$defs/Name" }
        }
      })
    }))
  add("recursive/identified", () => {
    const Tree: Schema.Top = S.Struct({ value: S.Int, children: S.Array(S.suspend(() => Tree)) }).annotate({
      identifier: "Tree"
    })
    return Tree
  })
  add("recursive/anonymous", () => {
    const Tree: Schema.Top = S.Struct({ value: S.Int, children: S.Array(S.suspend(() => Tree)) })
    return Tree
  })
  add("recursive/in-struct", () => {
    const Tree: Schema.Top = S.Struct({ value: S.Int, children: S.Array(S.suspend(() => Tree)) }).annotate({
      identifier: "Tree"
    })
    return S.Struct({ root: Tree, other: Tree })
  })
  add("recursive/anonymous-in-struct", () => {
    const Tree: Schema.Top = S.Struct({ value: S.Int, children: S.Array(S.suspend(() => Tree)) })
    return S.Struct({ root: Tree, other: Tree })
  })
  add("recursive/mutual", () => {
    const A: Schema.Top = S.Struct({ b: S.optionalKey(S.suspend(() => B)) }).annotate({ identifier: "A" })
    const B: Schema.Top = S.Struct({ a: S.optionalKey(S.suspend(() => A)) }).annotate({ identifier: "B" })
    return A
  })
  add("recursive/union", () => {
    const Nested: Schema.Top = S.Union([S.String, S.Array(S.suspend(() => Nested))])
    return Nested
  })
  add("recursive/suspend-described", () => {
    const Tree: Schema.Top = S.Struct({
      value: S.Int,
      next: S.optionalKey(S.suspend(() => Tree).annotate({ description: "next" }))
    }).annotate({ identifier: "Tree" })
    return Tree
  })

  // Classes.
  add("class/basic", () => {
    class A extends S.Class<A>("A")({ name: S.String }) {}
    return A
  })
  add("class/reuse", () => {
    class A extends S.Class<A>("A")({ name: S.String }) {}
    return S.Struct({ x: A, y: A })
  })
  add("class/described", () => {
    class A extends S.Class<A>("A")({ name: S.String }, { description: "an A" }) {}
    return A
  })
  add("class/nested", () => {
    class A extends S.Class<A>("A")({ name: S.String }) {}
    class B extends S.Class<B>("B")({ a: A, list: S.Array(A) }) {}
    return B
  })
  add("class/tagged", () => {
    class T extends S.TaggedClass<T>()("T", { n: S.Int }) {}
    return T
  })
  add("class/taggedError", () => {
    class E extends S.TaggedError<E>()("E", { message: S.String, attempt: S.Int }) {}
    return E
  })
  add("class/recursive", () => {
    class N extends S.Class<N>("N")({ next: S.optionalKey(S.suspend((): Schema.Codec<N, unknown> => N)) }) {}
    return N
  })
  add("class/union", () => {
    class A extends S.TaggedClass<A>()("A", { a: S.Int }) {}
    class B extends S.TaggedClass<B>()("B", { b: S.Int }) {}
    return S.Union([A, B])
  })
  add("class/same-identifier-equal", () => {
    class First extends S.Class<First>("A")({ name: S.String }) {}
    class Second extends S.Class<Second>("A")({ name: S.String }) {}
    return S.Struct({ x: First, y: Second, z: S.Array(Second) })
  })
  add("class/same-identifier-different", () => {
    class First extends S.Class<First>("A")({ name: S.String }) {}
    class Second extends S.Class<Second>("A")({ name: S.Int }) {}
    return S.Struct({ x: First, y: Second })
  })
  add("class/alias-content-schema", () => {
    class First extends S.Class<First>("A")({ name: S.String }) {}
    class Second extends S.Class<Second>("A")({ name: S.String }) {}
    return S.Struct({
      x: First,
      y: Second,
      z: S.String.annotate({
        contentSchema: {
          allOf: [
            { $ref: "#/$defs/AEncoded_1" },
            { $ref: "#/$defs/AEncoded_1/properties/name" },
            { $ref: "#%2F$defs%2FAEncoded_1%2Fproperties" },
            { $ref: "#/$defs/AEncoded" }
          ]
        }
      })
    })
  })
  add("class/alias-recursive", () => {
    class Inner extends S.Class<Inner>("K")({
      first: S.optionalKey(S.suspend((): Schema.Codec<First, unknown> => First)),
      second: S.optionalKey(S.suspend((): Schema.Codec<Second, unknown> => Second))
    }) {}
    class First extends S.Class<First>("P")({ inner: Inner }) {}
    class Second extends S.Class<Second>("P")({ inner: Inner }) {}
    return S.Struct({ first: First, second: Second })
  })

  // Brands. Under 4.0.4 a brand is not part of the schema, so these print as their base, and
  // `Node.representationIdentity` version 1 restores them from the schema value at every
  // position below: a member, an element, a value, an optional field, a nested struct.
  add("brand/string", () => S.String.pipe(S.brand("UserId")))
  add("brand/checked", () => S.String.check(S.isMinLength(1)).pipe(S.brand("UserId")))
  add("brand/identified", () => S.String.pipe(S.brand("UserId")).annotate({ identifier: "UserId" }))
  add("brand/reuse", () => {
    const UserId = S.String.pipe(S.brand("UserId"))
    return S.Struct({ a: UserId, b: UserId })
  })
  add("brand/identified-reuse", () => {
    const UserId = S.String.pipe(S.brand("UserId")).annotate({ identifier: "UserId" })
    return S.Struct({ a: UserId, b: UserId })
  })
  add("brand/identified-then-branded", () => {
    const UserId = S.String.annotate({ identifier: "Name" }).pipe(S.brand("UserId"))
    return S.Struct({ a: UserId, b: UserId })
  })
  add("brand/struct", () => S.Struct({ a: S.Int }).pipe(S.brand("P")))
  add("brand/int", () => S.Int.pipe(S.brand("Count")))
  add("brand/twice", () => S.String.pipe(S.brand("A"), S.brand("B")))
  add(
    "brand/annotated-around",
    () => S.String.annotate({ title: "t" }).pipe(S.brand("A")).annotate({ description: "d", title: "u" })
  )
  add("brand/then-checked", () => S.String.pipe(S.brand("A")).check(S.isMinLength(1)))
  add(
    "brand/between-checks",
    () => S.String.check(S.isMinLength(1)).pipe(S.brand("A")).check(S.isMaxLength(5)).pipe(S.brand("B"))
  )
  add("brand/array", () => S.Array(S.String.pipe(S.brand("A"))))
  add("brand/non-empty-array", () => S.NonEmptyArray(S.String.pipe(S.brand("A"))))
  add("brand/tuple", () => S.Tuple([S.String.pipe(S.brand("A")), S.Number]))
  add("brand/union", () => S.Union([S.String.pipe(S.brand("A")), S.Number.pipe(S.brand("B"))]))
  add("brand/null-or", () => S.NullOr(S.String.pipe(S.brand("A"))))
  add("brand/record", () => S.Record(S.String, S.Int.pipe(S.brand("Count"))))
  add("brand/optional-fields", () =>
    S.Struct({
      a: S.optionalKey(S.String.pipe(S.brand("A"))),
      b: S.optional(S.String.pipe(S.brand("B"))),
      c: S.mutableKey(S.String.pipe(S.brand("C")))
    }))
  add("brand/nested-struct", () => S.Struct({ inner: S.Struct({ id: S.String.pipe(S.brand("Id")) }) }))
  add(
    "brand/identified-container",
    () => S.Struct({ id: S.String.pipe(S.brand("Id")) }).annotate({ identifier: "Row" }).pipe(S.brand("R"))
  )
  add("brand/twice-annotated", () => S.String.annotate({ title: "t" }).pipe(S.brand("A"), S.brand("B")))
  add(
    "brand/tuple-with-rest",
    () => S.TupleWithRest(S.Tuple([S.String.pipe(S.brand("A"))]), [S.Number.pipe(S.brand("B"))])
  )
  add(
    "brand/struct-with-rest",
    () =>
      S.StructWithRest(S.Struct({ a: S.String.pipe(S.brand("A")) }), [S.Record(S.String, S.String.pipe(S.brand("B")))])
  )
  // A brand over a codec: rc.115 branded the decoded side, which the representation of the
  // encoded side never printed.
  add("brand/trim", () => S.Trim.pipe(S.brand("Slug")))
  add("brand/number-from-string", () => S.NumberFromString.pipe(S.brand("Port")))
  add("brand/number-from-string-checked", () => S.NumberFromString.check(S.isInt()).pipe(S.brand("Port")))
  add("brand/codec-field", () => S.Struct({ slug: S.Trim.pipe(S.brand("Slug")), count: S.Int }))

  // Codecs and declarations.
  add("transform/decodeTo", () => S.String.pipe(S.decodeTo(S.Number)))
  add("transform/struct-fields", () => S.Struct({ n: S.NumberFromString, d: S.Date }))
  add("transform/fromJsonString", () => S.fromJsonString(S.Struct({ a: S.Int })))
  add("transform/option", () => S.Option(S.String))
  add("transform/option-struct", () => S.Struct({ a: S.Option(S.Int), b: S.Option(S.Int) }))
  add("transform/optionFromNullOr", () => S.OptionFromNullOr(S.String))
  add("transform/redacted", () => S.Redacted(S.String))
  add("transform/redacted-struct", () => S.Struct({ token: S.Redacted(S.String) }))
  add("transform/result", () => S.Result(S.String, S.Number))
  add("transform/exit", () => S.Exit(S.String, S.Number, S.Defect()))
  add("transform/exit-unknown-defect", () => S.Exit(S.Struct({ a: S.Int }), S.String, S.Unknown))
  add("transform/cause", () => S.Cause(S.String, S.Defect()))
  add("transform/map", () => S.ReadonlyMap(S.String, S.Number))
  add("transform/set", () => S.ReadonlySet(S.String))
  add("transform/hashMap", () => S.HashMap(S.String, S.Number))
  add("transform/chunk", () => S.Chunk(S.String))
  add("transform/dates", () => S.Struct({ a: S.Date, b: S.Date, c: S.DateTimeUtc }))
  add("transform/duration", () => S.Struct({ a: S.Duration }))
  add("transform/declare", () => S.declare((value): value is Map<unknown, unknown> => value instanceof Map))
  add(
    "transform/declare-identified",
    () =>
      S.declare((value): value is Map<unknown, unknown> => value instanceof Map, {
        identifier: "MyMap",
        description: "a map"
      })
  )
  add("transform/declare-reuse", () => {
    const MyMap = S.declare((value): value is Map<unknown, unknown> => value instanceof Map, { identifier: "MyMap" })
    return S.Struct({ a: MyMap, b: MyMap })
  })
  add("transform/instanceOf", () => S.instanceOf(Map))
  add("transform/toEncoded", () => S.toEncoded(S.Struct({ n: S.NumberFromString })))
  add("transform/toType", () => S.toType(S.Struct({ n: S.NumberFromString })))
  add("transform/json-fields", () => S.Struct({ a: S.Json, b: S.Json }))
  add("transform/unknown-fields", () => S.Struct({ a: S.Unknown, b: S.Record(S.String, S.Unknown) }))

  return entries
}

/** One representation document of the corpus, as the plain value the emitter is handed. */
export type RepresentationEntry = () => unknown

/**
 * Representation documents no schema constructor produces.
 *
 * `Schema.Record` flattens a union key into one index signature per member,
 * and the constructors refuse a missing definition, a symbol property name and
 * a non-finite enum member before a representation exists. The emitter still
 * has a rule for each, so each is recorded here from rc.115's own
 * `SchemaRepresentation.toJsonSchemaDocument` and held the same way.
 */
export const representations = (S: SchemaModule): Readonly<Record<string, RepresentationEntry>> => {
  const of = (schema: Schema.Top): unknown => S.toRepresentation(S.toCodecJson(schema)).representation
  const string = { _tag: "String", checks: [] }
  const template = (prefix: string): unknown => of(S.TemplateLiteral([prefix, S.String]))
  const custom = (annotations: Readonly<Record<string, unknown>>) => ({ _tag: "Filter", aborted: false, annotations })
  const union = (types: ReadonlyArray<unknown>, extra: Readonly<Record<string, unknown>> = {}) => ({
    _tag: "Union",
    types,
    checks: [],
    ...extra
  })
  const objects = (
    propertySignatures: ReadonlyArray<unknown>,
    indexSignatures: ReadonlyArray<unknown>
  ) => ({ _tag: "Objects", propertySignatures, indexSignatures, checks: [] })
  const property = (name: PropertyKey, type: unknown) => ({ name, type, isOptional: false, isMutable: false })
  const record = (parameter: unknown, references: Readonly<Record<string, unknown>> = {}) => ({
    representation: objects([], [{ parameter, type: of(S.Finite) }]),
    references
  })
  const reference = ($ref: string) => ({ _tag: "Reference", $ref })
  const twins = (first: unknown, second: unknown) => ({
    representation: objects([property("a", reference("A")), property("b", reference("A_1"))], []),
    references: { A: first, A_1: second }
  })
  const fallback = (fragment: unknown) => ({
    _tag: "String",
    checks: [custom({ toJsonSchema: () => fragment, "~identifier": "A" })]
  })

  return {
    "key/union-templates": () => record(union([template("a-"), template("b-")])),
    "key/union-with-string": () => record(union([template("a-"), string, template("b-")])),
    "key/union-with-custom": () => record(union([template("a-"), { _tag: "String", checks: [custom({})] }])),
    "key/union-empty": () => record(union([])),
    "key/union-checked": () => record(union([template("a-")], { checks: [custom({ toJsonSchema: () => ({}) })] })),
    "key/union-oneOf": () => record(union([template("a-"), template("b-")], { options: { mode: "oneOf" } })),
    "key/union-anyOf": () => record(union([template("a-"), template("b-")], { options: { mode: "anyOf" } })),
    "key/union-nested": () => record(union([union([template("a-")]), reference("Key")]), { Key: template("k-") }),
    "key/reference": () => record(reference("Key"), { Key: template("k-") }),
    "key/reference-cycle": () => record(reference("Key"), { Key: reference("Key") }),
    "key/reference-missing": () => record(reference("Missing")),
    "key/string-two-checks": () =>
      record({ _tag: "String", checks: [custom({ toJsonSchema: () => ({ pattern: "^a" }) }), custom({})] }),
    "key/string-typed-check": () =>
      record({ _tag: "String", checks: [custom({ toJsonSchema: () => ({ pattern: "^a", type: "null" }) })] }),
    "key/string-pattern-not-text": () =>
      record({ _tag: "String", checks: [custom({ toJsonSchema: () => ({ pattern: 1 }) })] }),
    "reference/missing": () => ({ representation: reference("Missing"), references: {} }),
    "reference/inherited": () => ({ representation: reference("toString"), references: {} }),
    "property/symbol-name": () => ({ representation: objects([property(registered, string)], []), references: {} }),
    "enum/non-finite": () => ({
      representation: { _tag: "Enum", enums: [["A", 1], ["B", Number.POSITIVE_INFINITY]], checks: [] },
      references: {}
    }),
    "alias/equal": () =>
      twins(fallback({ minLength: 1, enum: ["a", 1, null] }), fallback({ enum: ["a", 1, null], minLength: 1 })),
    "alias/not-a-number": () => twins(fallback({ minimum: Number.NaN }), fallback({ minimum: Number.NaN })),
    "alias/array-length": () => twins(fallback({ enum: ["a"] }), fallback({ enum: ["a", "b"] })),
    "alias/array-member": () => twins(fallback({ enum: ["a", "b"] }), fallback({ enum: ["a", "c"] })),
    "alias/key-count": () => twins(fallback({ minLength: 1 }), fallback({ minLength: 1, maxLength: 2 })),
    "alias/key-name": () => twins(fallback({ minLength: 1 }), fallback({ maxLength: 1 })),
    "alias/array-and-object": () => twins(fallback({ const: [] }), fallback({ const: {} })),
    "alias/object-and-array": () => twins(fallback({ const: {} }), fallback({ const: [] })),
    "alias/number-and-text": () => twins(fallback({ const: 1 }), fallback({ const: "1" })),
    "alias/null-and-object": () => twins(fallback({ const: null }), fallback({ const: {} })),
    "alias/nested": () =>
      twins(
        fallback({ not: { enum: [{ a: [1, { b: null }] }] } }),
        fallback({ not: { enum: [{ a: [1, { b: null }] }] } })
      ),
    "alias/identified": () =>
      twins(
        { _tag: "String", checks: [], annotations: { identifier: "A", "~identifier": "A" } },
        { _tag: "String", checks: [], annotations: { identifier: "A", "~identifier": "A" } }
      ),
    "alias/unchecked": () =>
      twins(
        { _tag: "String", checks: [], annotations: { "~identifier": "A" } },
        { _tag: "String", checks: [], annotations: { "~identifier": "A" } }
      )
  }
}
