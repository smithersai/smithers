---
"@smthrs/harness": patch
---

A seat or thinking change pending after the model returns no longer discards the proposed cell, and a person's message or seat change that arrives while a cell runs no longer refuses the cell's later calls with a false "Outside changes are pending" message; only a committed outside change, now marked `outsideChange: true` on its `Steering.SteerInsert`, refuses them. When a person's message or an outside change holds a proposed cell, the next frame tells the model "This cell did not run" instead of sending an empty user message. A hold on the final frame grants the run one more frame, as an answered park does, instead of failing with `engine_failed`.
