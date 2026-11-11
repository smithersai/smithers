---
"@smthrs/build-cli": patch
---

The write-set guard no longer deletes or overwrites a file another process changed behind an escaping symlink while a target ran. A portal change is judged only when the body could have made it: an unconfined tool, a path an in-process body named through the link, or a scratch-copy body whose copy of the link still reaches the real target. Every portal revert first copies the bytes it removes into `<cache directory>/reverted/`, like the tracked and gitignored guards. `PackageTree.revertChangedPortals` takes `{ quarantine, admitted }`, and `PackageTree.portalsReachableFrom` lists the links a scratch copy still reaches.
