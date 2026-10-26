import { ElectricCollection, ShapeSource } from "@smthrs/effect-electric"
import { LiveQuery } from "@smthrs/effect-tanstack-db"
import { Context, Effect, Layer } from "effect"
import { AuthStore } from "../auth/store"
import { signedInShapeSource } from "../personal-model/source"
import { BUG_REPORTS_SHAPE_ROUTE } from "./contract"
import { BugReport } from "./schema"

// Bug reports on this tab (docs/features/bugs.md#the-inbox): Electric's `bug_reports` shape, kept on the device:
// every report for an Admin, a person's own for anyone else signed in, none signed out. The core serves them newest
// first to plugins as `core/bug-reports` (src/plugins/plugins.ts), where the bug plugin's inbox and form read them.

/** Where the reports sync from: ChatApi's origin, the site's own. */
export interface BugsConfig {
  readonly origin: string
}

/** The reports the viewer may see, newest first. */
const newestQuery = (reports: ElectricCollection.ElectricCollection<BugReport>) =>
  LiveQuery.make((q) =>
    q
      .from({ report: reports.tanstack })
      .orderBy(({ report }) => report.createdAt, "desc")
      .orderBy(({ report }) => report.id, "desc")
  )

export class BugsStore extends Context.Service<
  BugsStore,
  {
    readonly reports: ElectricCollection.ElectricCollection<BugReport>
    /** `core/bug-reports`: the reports the viewer may see, newest first. */
    readonly newest: Effect.Success<ReturnType<typeof newestQuery>>
  }
>()("@smthrs/mvp/bugs/BugsStore") {
  /** The store: its shape syncs once someone is signed in (`signedInShapeSource`). Needs sign-in's store. */
  static readonly layer = (config: BugsConfig) =>
    Layer.effect(
      BugsStore,
      Effect.gen(function* () {
        const auth = yield* AuthStore
        const source = yield* ShapeSource.ShapeSource
        const reports = yield* ElectricCollection.make<BugReport>({
          id: "bug-reports",
          schema: BugReport,
          getKey: (row) => row.id,
          syncMode: "eager",
          // Version 2: each report's error records (src/device/registry.ts).
          persist: { schemaVersion: 2 },
          shape: {
            url: `${config.origin}${BUG_REPORTS_SHAPE_ROUTE}`,
            columnMapper: ElectricCollection.snakeCamelMapper(),
            parser: { timestamptz: (value: string) => new Date(value).toISOString() },
          },
        }).pipe(Effect.provideService(ShapeSource.ShapeSource, signedInShapeSource(source, auth)))
        return BugsStore.of({ reports, newest: yield* newestQuery(reports) })
      }),
    )
}
