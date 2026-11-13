#!/bin/bash
# Prints the free disk, in MiB, that a benchmark instance can actually spend.
#
#   lib/disk-free.sh
#
# One instance costs an official image (2–3 GB) and an extracted testbed
# (1–3 GB), plus its evidence archive. These may land on different filesystems:
# SWB_ARTIFACT_ROOT holds the workspace, FB_DIR holds the archive, and Docker
# holds the image. Print the minimum free space across these destinations,
# resolving nonexistent directories to their nearest existing parent.
#
# The docker side is read by running `df` inside a container, because no docker
# command reports free space. The probe image is one that is **already local**;
# this never pulls, because a disk check that needs the network to answer
# "is there room to pull" is the wrong shape. When no probe image is present the
# answer is the host figure alone, and `--explain` says so.
#
#   SWB_DISK_PROBE_IMAGE   the probe image (default `alpine:latest`)
#   SWB_DISK_FREE_MIB      overrides the whole answer — for the rig's own tests,
#                          which need a disk gate that can be made to fail
#
# Spends nothing, needs no dataset, and never pulls.
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
PROBE="${SWB_DISK_PROBE_IMAGE:-alpine:latest}"
EXPLAIN=0
if [ "${1:-}" = "--explain" ]; then EXPLAIN=1; fi

if [ -n "${SWB_DISK_FREE_MIB:-}" ]; then
  case "$SWB_DISK_FREE_MIB" in
    ''|*[!0-9]*) echo "disk-free.sh: SWB_DISK_FREE_MIB must be a non-negative integer" >&2; exit 2 ;;
  esac
  if [ "$EXPLAIN" = "1" ]; then
    printf '%s MiB free (overridden by SWB_DISK_FREE_MIB)\n' "$SWB_DISK_FREE_MIB"
  else
    printf '%s\n' "$SWB_DISK_FREE_MIB"
  fi
  exit 0
fi

# Resolve the actual destinations through the same helper the worker uses.
ROOTS="$("$S/lib/run-paths.sh" flows --roots)"
eval "$ROOTS"
existing_parent() {
  local destination="$1"
  while [ ! -d "$destination" ]; do
    destination="$(dirname "$destination")"
  done
  (cd "$destination" && pwd -P)
}
free_mib() {
  local reading
  reading="$(df -k "$1")" || return 1
  printf '%s\n' "$reading" | awk 'END {
    if (NF < 4 || $4 !~ /^[0-9]+$/) exit 1
    printf "%d", $4 / 1024
  }'
}
WORK_DEST="$(existing_parent "$WORK_ROOT")"
ARCHIVE_DEST="$(existing_parent "${FB_DIR:-$S/fullbench}/archives")"
WORK_MIB="$(free_mib "$WORK_DEST")"
ARCHIVE_MIB="$(free_mib "$ARCHIVE_DEST")"
HOST_MIB="$WORK_MIB"
if [ "$ARCHIVE_MIB" -lt "$HOST_MIB" ]; then HOST_MIB="$ARCHIVE_MIB"; fi
HOST_SOURCE="workspace $WORK_DEST: $WORK_MIB MiB, archive $ARCHIVE_DEST: $ARCHIVE_MIB MiB"

# The docker VM's filesystem, when a probe image is already here to read it
# with. `docker run` writes its platform warning to stderr, which is discarded.
DOCKER_MIB=""
if command -v docker >/dev/null 2>&1 && docker image inspect "$PROBE" >/dev/null 2>&1; then
  RUN="docker"
  if command -v timeout >/dev/null 2>&1; then RUN="timeout 60 docker"; fi
  DOCKER_MIB="$($RUN run --rm "$PROBE" df -k / 2>/dev/null | tail -1 | awk '{ printf "%d", $4 / 1024 }' || true)"
  case "$DOCKER_MIB" in
    ''|*[!0-9]*) DOCKER_MIB="" ;;
  esac
fi

FREE="$HOST_MIB"
SOURCE="$HOST_SOURCE; no local probe image ($PROBE)"
if [ -n "$DOCKER_MIB" ]; then
  SOURCE="$HOST_SOURCE, docker VM ${DOCKER_MIB} MiB"
  if [ "$DOCKER_MIB" -lt "$FREE" ]; then FREE="$DOCKER_MIB"; fi
fi

if [ "$EXPLAIN" = "1" ]; then
  printf '%s MiB free (%s)\n' "$FREE" "$SOURCE"
else
  printf '%s\n' "$FREE"
fi
