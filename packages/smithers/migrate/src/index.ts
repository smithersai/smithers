/**
 * @since 1.0.0-rc.0
 *
 * `@smthrs/migrate` upgrades a Smithers 0.x (JSX) project to the Smithers
 * 1.0 authoring model and leaves an auditable report behind.
 *
 * The package is not a compatibility library. It never recreates the JSX
 * runtime, never embeds a scheduler in application code, never hides an
 * untranslatable construct behind `any`, and never rewrites or resumes 0.x run
 * state.
 */

/**
 * @category errors
 * @since 1.0.0-rc.0
 */
export * as MigrateError from "./MigrateError.ts"

/**
 * @category models
 * @since 1.0.0-rc.0
 */
export * as Constructs from "./Constructs.ts"

/**
 * @category models
 * @since 1.0.0-rc.0
 */
export * as Mapping from "./Mapping.ts"

/**
 * @category scanners
 * @since 1.0.0-rc.0
 */
export * as Detect from "./Detect.ts"

/**
 * @category scanners
 * @since 1.0.0-rc.0
 */
export * as RunState from "./RunState.ts"

/**
 * @category scanners
 * @since 1.0.0-rc.0
 */
export * as Inventory from "./Inventory.vibe"

/**
 * @category scanners
 * @since 1.0.0-rc.0
 */
export * as ZodSchemaHints from "./ZodSchemaHints.ts"

/**
 * @category scanners
 * @since 1.0.0-rc.0
 */
export * as PromptHints from "./PromptHints.ts"

/**
 * @category models
 * @since 1.0.0-rc.0
 */
export * as Units from "./Units.ts"

/**
 * @category checks
 * @since 1.0.0-rc.0
 */
export * as Checks from "./Checks.ts"

/**
 * @category models
 * @since 1.0.0-rc.0
 */
export * as Report from "./Report.ts"

/**
 * @category scanners
 * @since 1.0.0-rc.0
 */
export * as Scan from "./Scan.ts"

// lane flow appends below this line

/**
 * The migration contract: the system teaching, the prohibitions, the target
 * model, the worked pairs, and the per-unit prompt.
 *
 * @category flow
 * @since 1.0.0-rc.0
 */
export * as Contract from "./flow/Contract.ts"

/**
 * The two operator gates: 0.x run state, and constructs with no safe
 * translation.
 *
 * @category flow
 * @since 1.0.0-rc.0
 */
export * as Gate from "./flow/Gate.ts"

/**
 * What one migration run was asked to do.
 *
 * @category flow
 * @since 1.0.0-rc.0
 */
export * as Options from "./flow/Options.ts"

// The rest of the flow surface — `Checkpoint`, `Verify`, `Transform`,
// `Repair`, `Archive`, `MigrateFlow`, `Layers`, `Command`, and the
// `smithers-migrate` bin — is reached by subpath
// (`@smthrs/migrate/flow/Command`) rather than from this entry point, and the
// reason is a promise this package makes: `import "@smthrs/migrate"` loads the
// scanners and nothing else. A person deciding *whether* to migrate must not
// have to install the 1.0 runtime to find out, which is why every `@smthrs/*`
// dependency here is optional and why `test/flow/Dependencies.test.ts` pins
// the split.
