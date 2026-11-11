---
"@smthrs/build-cli": patch
"@smthrs/targets": patch
"@smthrs/platform-node": patch
---

Confined Go module downloads now reach exactly their declared `destinations`
through a scoped HTTP broker. DNS resolution happens in the broker while the
downloader keeps a closed bubblewrap network namespace; undeclared hosts and
direct connections stay denied. Previously the destination list was ignored
and fresh downloads failed with an unreachable-network error. With a declared
list, unsupported mechanisms or unrestricted sandbox policies are refused
rather than widening the network. A download without `destinations` runs
under its `sandbox` policy as before.

Each run has a private authenticated broker. Sandboxes mask the reserved
broker tree after broader mounts and refuse overlapping aliases, so another
closed-network target cannot borrow a live download's network grant. The
platform host implementation and relay runtime bytes enter the cache identity.
