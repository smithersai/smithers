# Workspace Tools and Sidebar Panels

## Summary

Evolve the sidebar into a multi-tool panel system with flexible placement and new tools.

## Context

- Smithers has a left-side file tree and tabs for terminals/chat/diff.
- There is no buffer list, markdown preview, or search results panel.

## Scope

- Create a panel framework with left/right/top/bottom docking and resizing.
- Persist panel visibility and size per workspace.
- Add a buffer list tool panel.
- Add a markdown preview panel with live updates and scroll sync.
- Add search-in-files results with preview and navigation.
- Add 'reveal current buffer' in the file tree and a global 'hide all tools'.

## Notes

- Design should match the existing Smithers UI language.
