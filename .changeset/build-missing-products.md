---
"@smthrs/build-cli": patch
---

Fail successful tool exits that leave declared outputs missing or output directories empty, naming the target and all missing paths. Refuse cached empty-directory build results without widening sandbox grants.
