---
"@smthrs/engine-store": patch
---

Compute a durable timer's remaining delay in its timer fiber. A clock advance
between registration and the fiber starting no longer extends the persisted
deadline.
