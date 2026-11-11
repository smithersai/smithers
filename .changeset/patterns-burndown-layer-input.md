---
"@smthrs/patterns": minor
---

`Burndown.layer` infers the burndown's input type from its members, as it does
the item type: annotate one member with `Burndown.ItemArgs<Input, Item>` and
every member reads `input` at that type, without a cast. `Burndown.child` of a
declared flow answers the flow's success type, so `land` and `detail` read the
work output without a cast.
