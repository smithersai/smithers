---
"@smthrs/effect-electric": patch
---

`reconnect` restarts a stopped shape however many times in a row it stopped: every stop now restarts as a new Electric stream from the last batch the collection committed, instead of relying on Electric's own restart, which gives up after 50 stops in a row. A 2xx of the shape's log without Electric's headers stops the shape before Electric sees it and is no longer reported `Succeeded`.
