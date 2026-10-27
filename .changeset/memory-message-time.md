---
"@smthrs/memory": minor
---

Add appendMessageOnce to atomically choose and return a message's first timestamp, including overlapping retries with omitted timestamps. Explicit timestamp, role and text conflicts remain errors; appendMessage keeps its required-timestamp contract.
