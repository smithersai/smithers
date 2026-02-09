# Remote Development

## Summary

Enable remote Neovim sessions via SSH or TCP connections.

## Context

- Smithers currently only supports local Neovim instances.
- Remote editing is a high-value workflow but complex to implement.

## Scope

- Add a connection manager for SSH and TCP endpoints.
- Handle authentication prompts and key management.
- Support reconnect and session persistence.
- Provide a UI for creating and switching remote targets.

## Notes

- Long-term feature; consider phased implementation.
