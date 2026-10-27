---
"@smthrs/platform-node": patch
---

Load the public injected Runtime module directly, avoiding the aggregate
barrel's browser sync graph and its Node localStorage startup warning.
