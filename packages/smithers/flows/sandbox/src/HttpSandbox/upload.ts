/**
 * Guest-side upload admission and publication.
 *
 * @since 1.0.0-rc.18
 */

import { digestSync } from "@smthrs/crypto"
import * as CommandLine from "@smthrs/kernel/CommandLine"

const q = CommandLine.quote

const safeParents = (path: string) =>
  path.split("/").slice(2)
    .map((_, index) => `[ ! -L ${q(path.split("/").slice(0, index + 3).join("/"))} ] || exit 3`).join("\n")

/** Serialize incarnation changes and writes, including the check immediately before publication.
 * A bounded set of lock inodes outlives all session receipts.
 * @category utilities
 * @since 1.0.0-rc.18
 */
export const sessionScript = (lock: string, state: string, body: string) => {
  const parent = lock.slice(0, lock.lastIndexOf("/"))
  const critical = `umask 077
${safeParents(state)}
r=${q(state)}
${body}`
  return `umask 077
${safeParents(lock)}
mkdir -p -- ${q(parent)} || exit 3
if command -v flock >/dev/null 2>&1; then exec flock -w 5 -E 75 ${q(lock)} sh -c ${q(critical)}
elif command -v lockf >/dev/null 2>&1; then exec lockf -k -t 5 ${q(lock)} sh -c ${q(critical)}
else exit 69; fi`
}

/**
 * The in-progress file beside a destination, with a bounded basename.
 *
 * @category utilities
 * @since 1.0.0-rc.18
 */
export const uploadStage = (path: string, upload: string): string =>
  `${path.slice(0, path.lastIndexOf("/")) || "/"}/.smthrs-upload-${digestSync(path).slice(0, 32)}-${upload}`

/**
 * Stages one range under a stable upload identity. A destination lock serializes
 * range writes and publication across handlers. Completed IDs stay as receipts
 * for the session lifetime, so a late delivery cannot replace a newer upload.
 * A pending publication is recovered before admitting any other write.
 *
 * @category utilities
 * @since 1.0.0-rc.18
 */
export const uploadScript = (
  path: string,
  root: string,
  upload: string,
  offset: number,
  end: number,
  total: number
) => {
  const critical = `umask 077
r=${q(root)}; f=${q(path)}; u=${q(`${root}/ids/${upload}`)}; d=${q(uploadStage(path, upload))}
publish() {
  [ ! -L "$f" ] && { [ ! -e "$f" ] || [ -f "$f" ]; } || return 1
  if [ -f "$f" ]; then
    metadata=$(stat -c '%u %g %a' -- "$f" 2>/dev/null) || metadata=$(stat -f '%u %g %Lp' "$f") || return 1
    set -- "$1" $metadata
    [ "$#" = 4 ] && chown "$2:$3" "$1" && chmod "$4" "$1" || return 1
  fi
  mv -f -- "$1" "$f"
}
[ ! -d "$f" ] || exit 3
if [ -f "$r/pending" ]; then
  read -r id <"$r/pending" || exit 3
  case "$id" in ''|*[!a-zA-Z0-9-]*) exit 3;; esac
  p="$r/ids/$id"; old=${q(uploadStage(path, ""))}"$id"
  [ ! -L "$p" ] && [ -d "$p" ] && [ ! -L "$old" ] && [ ! -L "$p/done" ] || exit 3
  if [ -f "$old" ]; then publish "$old" || exit 3; fi
  [ ! -f "$old" ] || exit 3
  touch "$p/done" && rm -f -- "$r/pending" || exit 3
fi
[ ! -L "$u" ] && [ ! -L "$d" ] && [ ! -L "$u/done" ] || exit 3
if [ -f "$u/done" ]; then cat >/dev/null; exit $?; fi
mkdir -p -- ${q(path.slice(0, path.lastIndexOf("/")) || "/")} "$u" || exit 3
[ -f "$d" ] || (set -C; : >"$d") || exit 3
s=$(wc -c <"$d") || exit 3
[ "$s" -ge ${offset} ] && [ "$s" -le ${total} ] || exit 3
if [ "$s" -ge ${end} ]; then cat >/dev/null || exit 3
else
  [ "$s" -le ${end} ] || exit 3
  exec 3<>"$d" || exit 3
  dd bs=1 count=0 seek=${offset} conv=notrunc >&3 2>/dev/null && cat >&3 || exit 3
  s=$(wc -c <"$d") && [ "$s" -eq ${end} ] || exit 3
fi
${
    end !== total ?
      "" :
      `printf '%s\\n' ${q(upload)} >"$r/pending.tmp" && mv -f -- "$r/pending.tmp" "$r/pending" || exit 3
publish "$d" && touch "$u/done" && rm -f -- "$r/pending" || exit 3`
  }
`
  return `umask 077
r=${q(root)}
${safeParents(root)}
mkdir -p -m 700 -- "$r" || exit 3
[ ! -L "$r/ids" ] && [ ! -L "$r/lock" ] && [ ! -L "$r/pending" ] && [ ! -L "$r/pending.tmp" ] || exit 3
[ -f "$r/lock" ] || (set -C; : >"$r/lock") 2>/dev/null || { [ -f "$r/lock" ] && [ ! -L "$r/lock" ]; } || exit 3
if command -v flock >/dev/null 2>&1; then exec flock -n -E 75 "$r/lock" sh -c ${q(critical)}
elif command -v lockf >/dev/null 2>&1; then exec lockf -k -t 0 "$r/lock" sh -c ${q(critical)}
else exit 69; fi
`
}
