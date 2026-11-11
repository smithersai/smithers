/**
 * Module flows: a `flow.ts` whose default export is `Flow.make("<tag>", { ... })`,
 * read from its source text without importing it.
 *
 * Discovery reads every module entry through {@link fromModule}, and a host
 * that holds a flow's source somewhere other than a file system (a database
 * row, an editor buffer) reads it the same way. Nothing here evaluates the
 * module: the description, schemas, calls, capabilities, effects, placement
 * and tag come from the literal declaration, and the body is recorded by the
 * digest of its bytes.
 *
 * @since 1.0.0-rc.16
 */

import * as Digest from "@smthrs/core/Digest"
import * as Option from "effect/Option"
import {
  BodyRefModule,
  DiscoveryWarning,
  FlowDescriptor,
  type ModuleImport,
  type Provenance,
  SchemaRefModule,
  SchemaRefNone
} from "./Descriptor.ts"
import * as ModuleMetadata from "./internal/ModuleMetadata.ts"
import { deriveBudget } from "./MarkdownFlow.ts"

/**
 * Parameters used to derive a descriptor from already-read module text.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface FromModuleOptions {
  /** The module's source, or a prefix of it that holds the whole default declaration. */
  readonly text: string
  /** SHA-256 of the complete source when the supplied text is a prefix; else the text's own digest. */
  readonly contentDigest?: string | undefined
  readonly path: string
  readonly naming: "path" | "frontmatter"
  /** The path-derived name, which a path-named source answers to. */
  readonly name: Option.Option<string>
  /** The entry's directory name, which a frontmatter-named source answers to. */
  readonly dirBasename: string
  readonly provenance: Provenance
  /** What the module loads beside itself, recorded on its body when any. */
  readonly imports?: ReadonlyArray<ModuleImport> | undefined
  readonly hostImports?: ReadonlyArray<string> | undefined
}

/**
 * The metadata result of module flow discovery: the descriptor, the tag the
 * declaration names, and what the reader warned about.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface FromModuleResult {
  readonly descriptor: Option.Option<FlowDescriptor>
  /**
   * The string literal `Flow.make` takes as its tag. `None` for a record
   * declaration, or a tag the reader cannot evaluate without running the module.
   */
  readonly tag: Option.Option<string>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}

const warning = (code: DiscoveryWarning["code"], path: string, message: string, name: string): DiscoveryWarning =>
  new DiscoveryWarning({ code, path, message, name })

/**
 * Derives a module flow descriptor from its source text without importing it.
 * A declaration without a literal description has no descriptor.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export const fromModule = (options: FromModuleOptions): FromModuleResult => {
  const metadata = ModuleMetadata.parse(options.text)
  // A root-level entry in a path-named source is refused before the read, so
  // a module reaching Discovery always has a path name; a frontmatter-named
  // source names it after its directory instead.
  const name = Option.getOrElse(
    options.naming === "path" ? options.name : Option.none<string>(),
    () => options.dirBasename
  )
  const warnings: Array<DiscoveryWarning> = []
  for (const item of metadata.warnings) {
    warnings.push(warning(
      "unsupported_module_metadata",
      options.path,
      item.line === undefined ? item.message : `${item.message} at ${options.path}:${item.line}`,
      name
    ))
  }
  // `Flow.make` requires a name, because the name is the tag the flow, its
  // action, and every plan that records a call carry. In a path-named source
  // the registry name is the path, so a module that declares the same string
  // is saying one thing twice and nothing is ignored. A module that declares a
  // different one is: the path still wins, and the author has to be told which
  // name the registry answers to. A name this reader cannot evaluate is warned
  // about for the same reason, because it cannot be shown to agree.
  if (options.naming === "path" && metadata.declaresName && !Option.contains(metadata.declaredName, name)) {
    warnings.push(
      warning(
        "name_field_ignored",
        options.path,
        "Ignoring Flow.make name because this source uses path-derived names",
        name
      )
    )
  }
  const budget = metadata.budget === undefined
    ? undefined
    : deriveBudget({ budget: metadata.budget }, options.path, warnings, "Flow.make budget")
  if (metadata.description === undefined) {
    warnings.push(
      warning(
        "missing_description",
        options.path,
        "Module flows require a literal description in the default Flow.make value",
        name
      )
    )
    return { descriptor: Option.none(), tag: metadata.tag, warnings }
  }
  const imports = options.imports ?? []
  const hostImports = options.hostImports ?? []
  return {
    descriptor: Option.some(
      new FlowDescriptor({
        name,
        description: metadata.description,
        body: new BodyRefModule({
          path: options.path,
          contentDigest: options.contentDigest ?? Digest.digest(options.text),
          ...(metadata.prompt === true ? { prompt: true } : {}),
          // Absent, not empty, when the entry loads nothing beside itself: such
          // a module keeps the identity it had before a closure was recorded.
          ...(imports.length === 0 ? {} : { imports }),
          ...(hostImports.length === 0 ? {} : { hostImports })
        }),
        input: metadata.hasInput
          ? new SchemaRefModule({
            path: options.path,
            field: "input",
            ...metadata.inputDocument === undefined ? {} : { document: metadata.inputDocument }
          })
          : new SchemaRefNone({}),
        output: metadata.hasOutput
          ? new SchemaRefModule({ path: options.path, field: "output" })
          : new SchemaRefNone({}),
        model: metadata.model,
        flows: metadata.flows,
        capabilities: metadata.capabilities,
        effects: metadata.effects,
        placement: metadata.placement,
        modelInvocable: metadata.modelInvocable,
        ...budget === undefined ? {} : { budget },
        path: options.path,
        frontmatter: {},
        provenance: options.provenance
      })
    ),
    tag: metadata.tag,
    warnings
  }
}
