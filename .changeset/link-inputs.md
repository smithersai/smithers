---
"@smthrs/targets": minor
"@smthrs/build-cli": minor
"@smthrs/platform-node": minor
---

A tracked symbolic link is a declarable input. `S.link(path)` keys the link by its own target string, never by the content behind it: retargeting the link re-keys the target, and files behind it re-key it only when they are declared themselves. Under bubblewrap and seatbelt the run sees the link at the same path with the same target, and nothing behind it is readable unless declared; Docker confinement refuses link inputs. A link whose target is absolute or leaves the workspace fails planning with `link_input_refused`, naming the path. A glob that is a declared input now lists the links it matches as link inputs instead of silently dropping them, and enters a `node_modules` directory that a `.gitignore` negation rule un-ignores. `S.file` on a link to a directory names `S.link`, and a declared output file that is a link names `outDirs`.
