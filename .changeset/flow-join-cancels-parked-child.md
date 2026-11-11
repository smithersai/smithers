---
"@smthrs/flow": patch
---

A `Node.race`, `Node.any` or `Node.quorum` cancels a losing `.child()` whose
child execution had already suspended when the join decided. The join used to
cancel only children whose node was still running, so a child that parked on
a human task, a deferred or a timer stayed open after its parent completed.
The join now journals and cancels every losing child that has not completed or
failed, live and on replay.
