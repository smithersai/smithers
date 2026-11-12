---
"@smthrs/platform-cloudflare": patch
---

`ExecutionObject.make().cancel` arms the object's alarm again once its cancel request ends, success or failure. An alarm that parked while the request was committing deleted the alarm `cancel` had set and could read the store before the commit, leaving the run suspended with no alarm until an unrelated `wake` or `start`.
