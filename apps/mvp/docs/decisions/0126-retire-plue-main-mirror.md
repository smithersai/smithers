# 0126: Retire the Plue main mirror

Date: 2026-10-29. Applies SCOPE-3 and ARCH-1 to repository automation.

Delete the workflow that pushed this repository's main to the retired Plue service.
Its pushes have returned 502 since October 22. Retrying an unused deployment is
not a repair: apps/mvp replaced the old app and backend under SCOPE-3.

No current app, build or release consumer reads the mirror repository's contents.
The app imports GitHub repositories through Code Storage, including the durable
refresh described in decision 0105. SDK cache defaults and historical fixtures
that mention the old service do not consume this mirror or its push receipt.

Remove the workflow, its actionlint inputs and its credential references from the
workflow declarations and migration proposal. No credential value is read, and
repository secret administration is outside this source change. The old SDK
protocol and persisted-history readers remain intact under the libraries-we-keep
ruling. Do not add product code to Plue.
