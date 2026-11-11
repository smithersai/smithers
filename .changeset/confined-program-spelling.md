---
"@smthrs/platform-node": patch
---

A confined command now runs a system program by the name it was given. `ProcessConfinement` resolved every program under `/usr`, `/bin` or `/opt/homebrew` to the file behind its symlinks, so on a BusyBox host `/bin/sh -c` ran as `busybox -c` and every confined command failed, and on Debian `unxz` ran as `xz` and compressed. The confinement also refuses a `bwrap` or `docker` program found inside the workspace, such as a `node_modules/.bin/bwrap` ahead on the `PATH` of a host started by `pnpm run`, because that program runs on the host outside the sandbox. The host lookup no longer searches relative `PATH` entries.
