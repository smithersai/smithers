---
title: Views, filters, and themes
description: Keep a busy terminal readable without losing the recorded history.
order: 11
section: Use the TUI
---

Tabs contain Chat, Summary, workers, flow runs, trees, and custom views. **Ctrl+]** moves forward; **Ctrl+\\** returns toward chat. **Ctrl+Right/Ctrl+Left** are aliases, though some desktops reserve them. Click a tab to open it; overflow arrows reveal the remaining tabs.

## Filter the transcript

```tui-script transcript-filter
Use "basic"
Type "Explain math.js"
Press Enter
Wait for answer "Ready."
Type "/filter"
Press Enter
Capture "Choose which lanes and row kinds appear in chat."
Press Escape
Type "/grep Ready"
Press Enter
Capture "Keep only rows matching text."
Type "/grep"
Press Enter
Capture "Clear the text filter."
```

`/filter` toggles chat, each worker lane, and row kinds. `/grep text` filters visible rows; `/grep` clears that text. Filtering changes the view, not saved events or the files.

## Change the accent

```tui-script themes
Use "basic"
Type "/theme"
Press Enter
Wait for "green"
Capture "Choose a terminal accent."
Press ArrowDown
Press ArrowDown
Press Enter
Capture "Apply the theme without leaving the session."
```

The four accents are purple, blue, green, and orange on Night Owl surfaces. The choice is saved in `~/.smithers/tui/theme`. Worker lanes use distinct colors to keep their output separate from chat.

Custom main views sit beside chat at 120 columns or wider and above it in smaller terminals. Worker lists appear beside chat at 100 columns. See [custom views](../automation/views.md) for authoring those surfaces.
