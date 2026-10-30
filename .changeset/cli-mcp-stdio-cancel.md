---
"@smthrs/cli": patch
---

Stop a cancelled MCP stdio session from writing parse-error replies once output drains, and fail instead of waiting forever when MCP output closes.
