---
"@smthrs/merge-queue": minor
---

`JjRepository`: the target branch as a local jj bookmark. A candidate is built by replaying each change's commit onto
the bookmark's tip, landing moves the bookmark forward onto exactly the tested commit, and a commit someone else put
on the bookmark is reported as a foreign part. It runs `jj` through Effect's `ChildProcessSpawner`.
