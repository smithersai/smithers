# @smthrs/opencode

## [Unreleased]

### Added

- Initial package: an OpenCode protocol v1 server over the Smithers agent
  loop for the hosted OpenCode app. Routes with the 1.18.31 response shapes,
  the `/global/event` stream with heartbeats and replay, a SQLite store for
  sessions, messages, parts and pending permissions, the pure projection from
  harness events to OpenCode events, the `Driver` seam, and a scripted driver
  that replays a recorded turn with a permission park.
