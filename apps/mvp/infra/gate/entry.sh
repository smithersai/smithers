#!/bin/sh
# The gate machine's entry (decision 0128, gap (d)): as root, before anything runs, /tmp becomes a tmpfs, since the
# container's disk is btrfs and its fsync is slow (a shard took 730 s with TMPDIR on disk, 213 s on tmpfs). Then the
# box idles as `smithers`, as the branch sandbox's does. A mount the runtime refuses leaves /tmp on disk: slower, and the
# step's own records show it (`findmnt /tmp`).
mount -t tmpfs -o size=8g,mode=1777 tmpfs /tmp || echo "smithers-gate-entry: /tmp stays on disk" >&2
exec setpriv --reuid=1000 --regid=2000 --init-groups smithers-idle infinity
