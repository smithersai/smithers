---
"@smthrs/build-cli": patch
---

A step that uv or mypy runs is reused when nothing it read changed. A directory a step makes as `dir/`, with a slash at the end, and then moves, as uv does when it fills its cache, carries the files the step wrote in it: every path in a trace is now named in one spelling (`a//b/` and `a/./b` are `a/b`). A file a step finds, changes and leaves, as mypy does with a cache a cache step puts back, is held as the step left it or as it found it: before a step runs, the build measures the files its earlier runs wrote.
