import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import type { Composer } from "../chat/schema"
import type { Menu, Palette } from "./schema"

// What frontends read of the command menu: its row, while it is the menu for the composer's draft. Any other change to
// the draft (asking clears it, Edit on an unsent question fills it) leaves the row for an older draft, which the join
// hides, so the view never shows a menu for text that isn't there.

/** The menu for the composer's draft, if it has one. */
export const menuQuery = (menu: Collection.Collection<Menu, string>, composer: Collection.Collection<Composer, string>) =>
  LiveQuery.make((q) =>
    q
      .from({ menu: menu.tanstack })
      .innerJoin({ composer: composer.tanstack }, ({ menu, composer }) => Query.eq(menu.draft, composer.draft))
      .select(({ menu }) => ({
        id: menu.id,
        kind: menu.kind,
        label: menu.label,
        items: menu.items,
        highlighted: menu.highlighted,
        refusal: menu.refusal,
      }))
      .findOne()
  )

/** The global command palette's state row (`⌘P` / `Ctrl+P`). */
export const paletteQuery = (palette: Collection.Collection<Palette, string>) =>
  LiveQuery.make((q) => q.from({ palette: palette.tanstack }).findOne())
