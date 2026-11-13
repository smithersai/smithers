---
title: "Build stamps"
description: "S.Stamp provenance values for a Go binary: why they resolve after the content key, and why a secret is refused."
sidebar:
  order: 4
---

`S.Stamp.version`, `S.Stamp.commit`, `S.Stamp.commitDate`,
`S.Stamp.buildTime`, and `S.Stamp.versionMeta` are inert values a Go binary's
`stamp` map uses to record where a build came from. A stamp may also be a
public literal string.

`S.Stamp.versionMeta` resolves to an empty string when a tag points at the
current commit, or `"dev"` when no tag does. A failed repository read fails
the target rather than substituting `"dev"`.

They resolve immediately before the child process spawns, after the content key
is complete. That ordering is the point: a commit hash and a build time change
on every commit, and keying on them would make every build a miss. The split
follows Bazel's workspace-status semantics. Stable source and tool inputs
determine the reusable key, while volatile provenance is injected into the link
command. A cache hit restores the captured binary without re-reading a stamp.

A [`Smithers.Secret`](../api.md) is refused as a stamp value. A value
embedded in a binary has crossed into the job and into its cache artifact,
while a Smithers secret may be resolved only by the outbound proxy at the I/O
boundary. Refusing at declaration time is what keeps that guarantee true.
