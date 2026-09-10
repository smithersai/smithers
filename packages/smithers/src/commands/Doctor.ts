/**
 * `smthrs doctor`: the report, from either catalog source.
 *
 * @since 1.0.0
 */
import { Control as ControlService } from "@smthrs/control"
import * as ResolveJj from "@smthrs/jj/node/resolveJjBinary"
import * as Registry from "@smthrs/registry/Registry"
import { Effect } from "effect"
import * as Doctor from "../Doctor.ts"
import * as Project from "../Project.ts"
import * as Unsupported from "../Unsupported.ts"
import * as FlowCatalog from "./FlowCatalog.ts"
import * as Globals from "./Globals.ts"

/**
 * The report for one already-read catalog.
 * @category constructors
 * @since 1.0.0
 */
export const report = (
  catalog: Pick<FlowCatalog.FlowPage, "items" | "warnings">,
  globals: Globals.Options
): Effect.Effect<Doctor.Report> =>
  Effect.gen(function*() {
    // Doctor owns the unsupported-backend check. The shared guard would fail
    // before the report exists, so this verb prints the notices and lets
    // `Doctor.failed` decide the command status from the complete report.
    yield* Globals.notices(globals)
    const environment = globals.environment ?? process.env
    const projectRoot = yield* Project.ProjectRoot
    return Doctor.inspect({
      root: projectRoot,
      environment: globals.backend === undefined ? environment : { ...environment, SMITHERS_BACKEND: globals.backend },
      jj: ResolveJj.resolveJjBinary(),
      legacyPaths: yield* Project.LegacyState,
      discoveredFlows: catalog.items.filter((item) => !Unsupported.isReservedFlow(item.flowId)),
      discoveryWarnings: catalog.warnings
    })
  })

/**
 * Local diagnostics use the discovery snapshot without opening execution databases.
 * @category constructors
 * @since 1.0.0
 */
export const fromRegistry = (
  globals: Globals.Options
): Effect.Effect<Doctor.Report, never, Registry.Registry> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    const [descriptors, warnings] = yield* Effect.all([registry.list(), registry.warnings()])
    return yield* report({
      items: descriptors.map((descriptor) => ({ flowId: descriptor.name, description: descriptor.description })),
      warnings
    }, globals)
  })

/**
 * Remote diagnostics read the catalog the selected control plane serves.
 * @category constructors
 * @since 1.0.0
 */
export const fromControl = (globals: Globals.Options) =>
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    return yield* report(yield* FlowCatalog.read(control), globals)
  })
