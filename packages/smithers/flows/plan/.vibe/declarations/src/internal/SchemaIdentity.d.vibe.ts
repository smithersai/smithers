/**
 * The schema identity projection: the JSON-Schema-shaped document a schema
 * contributes to a step key.
 *
 * A call node folds what its callee accepts and produces into the material a
 * step key is derived from, and a catch node folds its filter the same way. A
 * projection that printed differently under another `effect` release would
 * re-key every recorded step in every journal at once. `effect` is a peer
 * range, so the application picks the release; the projection therefore
 * cannot be the installed `Schema.toJsonSchemaDocument`. `effect@4.0.4`
 * already changed what that emitter prints for `Schema.Int`, `isMinLength`,
 * `isPattern`, repeated bounds, `oneOf` unions and shared definitions.
 *
 * This module owns the bytes instead. It reads the schema through two public
 * functions, `Schema.toCodecJson` and `Schema.toRepresentation`, and prints
 * the result with the emitter and the check fragments fixed below, which
 * reproduce `Schema.toJsonSchemaDocument(schema, options)` of
 * `effect@4.0.0-rc.115` for both values of `onExcessProperty`.
 *
 * It is for identity only. Where a JSON Schema is shown to a model or a
 * person, the installed emitter is the right one.
 *
 * What still moves an identity, by design: a release that changes a schema's
 * JSON codec or its representation changes what the schema accepts on the
 * wire. Three limits follow from what the representation carries:
 *
 * - A built-in check contributes the constraint its id and payload name. A
 *   `toJsonSchema` annotation passed to a built-in check constructor is not
 *   consulted; one on a `makeFilter` check is.
 * - A built-in check this module does not list falls back to the installed
 *   check's own `toJsonSchema` annotation.
 * - `Schema.brand` is not part of the representation from `effect@4.0.4` on.
 *   Under rc.115 a schema that takes a definition (an `identifier` or a
 *   recursive schema) and appeared both branded and unbranded in one document
 *   got two definitions; it now gets one. The representation identity is
 *   versioned for this reason: see {@link representationIdentityVersions}.
 *
 * Provenance: {@link fromRepresentation} and its helpers are adapted from
 * `effect@4.0.0-rc.115` (MIT, Copyright (c) 2023 Effectful Technologies Inc;
 * the notice is in this package's `THIRD_PARTY_NOTICES.md`), files
 * `src/internal/schema/toJsonSchemaDocument.ts`, `src/JsonSchema.ts`
 * (`rewriteRefs`), `src/JsonPointer.ts` and `src/SchemaAST.ts` (`isJson`).
 * Changes: `onExcessProperty` is the only option; one root; a built-in
 * check's fragment comes from {@link builtinChecks}, not from
 * the installed annotation; an approximate check result contributes its
 * schema.
 *
 * @since 1.0.0
 */
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
/**
 * The document a schema's identity is: exactly what rc.115 returned from
 * `Schema.toJsonSchemaDocument`, key order included.
 *
 * @since 1.0.0
 * @private
 */
export type Document = JsonSchema.Document<"draft-2020-12">;
/**
 * How an object schema treats a key it does not declare, which is the one
 * emitter option a declaration's identity is taken under. It has rc.115's
 * meaning and rc.115's default: `"ignore"` leaves such keys open, `"error"`
 * closes them.
 *
 * @since 1.0.0
 * @private
 */
export interface Options {
    readonly onExcessProperty?: "ignore" | "error" | undefined;
}
declare const SchemaIdentityError_base: Schema.Class<SchemaIdentityError, Schema.TaggedStruct<"@smthrs/plan/SchemaIdentityError", {
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A schema a step key cannot be derived from: one with no JSON Schema form or
 * no representation, or one whose built-in check the installed `effect`
 * describes differently from the releases this package supports. The message
 * is the one `effect@4.0.0-rc.115` gave for the same schema, where it gave one.
 *
 * @since 1.0.0
 * @category errors
 */
export declare class SchemaIdentityError extends SchemaIdentityError_base {
}
/**
 * The ids {@link builtinChecks} lists, for the test that holds the list
 * against the checks the installed `effect` can revive.
 *
 * @since 1.0.0
 * @private
 */
export declare const builtinCheckIds: ReadonlyArray<string>;
/**
 * Prints a representation document as the JSON Schema document rc.115
 * printed for it under the same options.
 *
 * Reserved for {@link schemaIdentity} and for the tests that hand it a
 * representation no schema produces.
 *
 * @since 1.0.0
 * @private
 */
export declare const fromRepresentation: (document: SchemaRepresentation.Document, options?: Options) => Document;
/**
 * The identity a schema contributes: a pure function of the schema and the
 * option, and of nothing the installed `effect` release prints. It takes the
 * place of `Schema.toJsonSchemaDocument(schema, options)` wherever the
 * document is hashed, compared or pinned.
 *
 * Throws what rc.115 threw for a schema with no JSON Schema form: more than
 * one rest element, a record key that is neither a string nor a template, a
 * `toJsonSchema` annotation that throws.
 *
 * @since 1.0.0
 * @private
 */
export declare const schemaIdentity: (schema: Schema.Top, options?: Options) => Document;
/**
 * The versions of a representation identity, newest first. A sealed action's
 * step key hashes one, and a key written under an older version must stay
 * derivable, so a version is never changed once published; a change adds a
 * version at the front.
 *
 * - `2`, the current version, written since `effect@4.0.4` (2026-10-13):
 *   what the installed release encodes, with the six check ids renamed after
 *   `4.0.0-rc.115`, and the check annotations and string `content`
 *   `effect@4.1.0` changed, written back. From `4.0.4` on `Schema.brand` is not part of
 *   the AST, so a brand contributes nothing.
 * - `1`, what every key written under `4.0.0-rc.115` hashed: version 2 with
 *   each brand restored as the `brands` annotation rc.115 wrote, in the place
 *   and key order rc.115 wrote it.
 *
 * @since 1.0.0
 * @private
 */
export declare const representationIdentityVersions: readonly [2, 1];
/**
 * One version of {@link representationIdentityVersions}.
 *
 * @since 1.0.0
 * @private
 */
export type RepresentationIdentityVersion = (typeof representationIdentityVersions)[number];
/**
 * The representation identity of a schema: what
 * `SchemaRepresentation.toJson(SchemaRepresentation.toRepresentation(schema.ast))`
 * returned under `effect@4.0.0-rc.115`, key order included, in the given
 * {@link representationIdentityVersions version} (the newest by default). A
 * sealed action's step key hashes it, so it must not move with the installed
 * `effect`.
 *
 * The installed release encodes the representation; this writes back the six
 * check ids renamed after rc.115, and the check annotations and string
 * `content` `effect@4.1.0` changed. From `effect@4.0.4` on `Schema.brand` is not
 * part of the AST, so version 2 omits it, and version 1 restores it from the
 * schema value, where the brand still lives.
 *
 * Throws what rc.115 threw for a schema with no representation, such as one
 * whose check carries no `representation` annotation.
 *
 * @since 1.0.0
 * @private
 */
export declare const representationIdentity: (schema: Schema.Top, version?: RepresentationIdentityVersion) => Schema.Json;
export {};
