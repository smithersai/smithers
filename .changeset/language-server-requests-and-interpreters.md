---
"@smthrs/platform-node": patch
---

`NodeLanguageServer` answers the server's own requests (`workspace/configuration`, `client/registerCapability`, `workspace/applyEdit` and the rest) instead of matching them against its pending requests, so a server request that reuses a client id no longer completes that request with nothing, and a server that awaits an answer no longer stalls. The workspace-program check now refuses command wrappers and tool runners (`nice`, `timeout`, `corepack`, `bundle`, `uvx`, `mise`, `bun`, `tsx` and others), and starts an interpreter (`node`, `python`, `ruby`, `perl`, versioned names included) only when it names an existing script file with no code or module flag before it, so `python -m pylsp`, `node -pe` and `python -X <file> -m` are refused.
