/**
 * Guest-side upload admission and publication.
 *
 * @since 1.0.0-rc.18
 */

import { digestSync } from "@smthrs/crypto"
import * as CommandLine from "@smthrs/kernel/CommandLine"

const q = CommandLine.quote

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
  const critical = `r=${q(root)}; f=${q(path)}; u=${q(`${root}/ids/${upload}`)}; d=${q(uploadStage(path, upload))}
[ ! -d "$f" ] || exit 3
if [ -f "$r/pending" ]; then
  read -r id <"$r/pending" || exit 3
  case "$id" in ''|*[!a-zA-Z0-9-]*) exit 3;; esac
  p="$r/ids/$id"; old=${q(uploadStage(path, ""))}"$id"
  [ ! -L "$p" ] && [ -d "$p" ] && [ ! -L "$old" ] && [ ! -L "$p/done" ] || exit 3
  [ -f "$old" ] && mv -f -- "$old" "$f"
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
mv -f -- "$d" "$f" && touch "$u/done" && rm -f -- "$r/pending" || exit 3`
  }
`
  const prefixes = root.split("/").slice(2).map((_, index) => root.split("/").slice(0, index + 3).join("/"))
  return `r=${q(root)}
${prefixes.map((prefix) => `[ ! -L ${q(prefix)} ] || exit 3`).join("\n")}
mkdir -p -m 700 -- "$r" || exit 3
[ ! -L "$r/ids" ] && [ ! -L "$r/lock" ] && [ ! -L "$r/pending" ] && [ ! -L "$r/pending.tmp" ] || exit 3
[ -f "$r/lock" ] || (set -C; : >"$r/lock") 2>/dev/null || { [ -f "$r/lock" ] && [ ! -L "$r/lock" ]; } || exit 3
if command -v flock >/dev/null 2>&1; then exec flock -n -E 75 "$r/lock" sh -c ${q(critical)}
elif command -v lockf >/dev/null 2>&1; then exec lockf -k -t 0 "$r/lock" sh -c ${q(critical)}
else exit 69; fi
`
}
