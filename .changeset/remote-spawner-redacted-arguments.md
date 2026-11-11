---
"@smthrs/sandbox": patch
---

`RemoteChildProcessSpawner` sends the provider `CommandLine.renderForExecution(command)`, so a `Redacted` argument runs with its value on a remote machine instead of the literal `<redacted>`. Every `PlatformError` still names the command by `CommandLine.render`, which keeps the value out of error text.
