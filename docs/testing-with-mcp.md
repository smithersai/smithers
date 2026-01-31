# Testing Smithers App with MCP Automation

This guide explains how AI agents (Claude Code, Amp, Codex) can observe and test the Smithers macOS app while building it.

## Prerequisites

### macOS Permissions Required

Before MCP servers can control apps, you MUST grant permissions:

1. **Screen Recording** (for mac-commander screenshots):
   - System Settings → Privacy & Security → Screen Recording
   - Add Terminal.app (or your AI client)
   - ✅ Enable the checkbox

2. **Accessibility** (for UI automation):
   - System Settings → Privacy & Security → Accessibility
   - Add Terminal.app (or your AI client)
   - ✅ Enable the checkbox

3. **Automation** (for AppleScript control):
   - System Settings → Privacy & Security → Automation
   - Add Terminal.app
   - ✅ Enable checkboxes for apps you want to control

**Restart your terminal after granting permissions.**

---

## MCP Servers Installed

### 1. macos-automator (596★ - Most Popular)

**What it does**: Runs AppleScript/JXA scripts and queries the macOS accessibility tree.

**Best for**:
- Finding UI elements by accessibility properties
- Clicking buttons, typing text via accessibility API
- Running AppleScript to control apps
- Getting window information

**Example prompts for the agent**:
```
"Use macos-automator to get all windows of Smithers.app"
"Use accessibility_query to find all buttons in the Smithers window"
"Execute AppleScript: tell application \"Smithers\" to activate"
```

### 2. mac-commander (11★ - Visual/Screenshot-based)

**What it does**: Takes screenshots, does OCR, finds UI elements visually, clicks at coordinates.

**Best for**:
- Taking screenshots of the app
- Finding text on screen via OCR
- Clicking at specific coordinates
- Visual debugging (see what the app looks like)

**Example prompts for the agent**:
```
"Use mac-commander to take a screenshot of the screen"
"Use mac-commander to find the text 'New Chat' on screen"
"Use mac-commander to click at coordinates 100, 200"
```

---

## Testing Workflow for Agents

### Step 1: Build and Launch the App
```bash
# Build the app
zig build run

# Or build without running:
xcodebuild -project macos/Smithers.xcodeproj -scheme Smithers -configuration Debug SYMROOT=macos/build build

# Then launch:
open macos/macos/build/Debug/Smithers.app
```

### Step 2: Observe the App

**Option A: Screenshot-based (mac-commander)**
```
"Take a screenshot of the current screen and describe what you see"
"Find all UI elements on the Smithers app"
"Look for any error messages on screen"
```

**Option B: Accessibility-based (macos-automator)**
```
"Use accessibility_query to list all UI elements in the Smithers app"
"Get the window title and size of Smithers"
```

### Step 3: Interact with the App

```
"Click the 'New Chat' button in Smithers"
"Type 'Hello World' in the input field"
"Press Cmd+K to open the skills palette"
```

### Step 4: Verify Results

```
"Take a screenshot after clicking the button"
"Check if 'Hello World' appears in the chat"
"Look for any error dialogs"
```

---

## Common Testing Scenarios

### Test: App Launches Successfully
```
1. Build and open the app
2. Take a screenshot
3. Verify the main window appears with sidebar and detail view
```

### Test: New Chat Button Works
```
1. Find the "New Chat" button using OCR or accessibility
2. Click it
3. Verify a new session appears in the sidebar
```

### Test: Input Field Accepts Text
```
1. Click on the input field at the bottom
2. Type some text
3. Take a screenshot to verify text appears
```

### Test: Sidebar Navigation
```
1. Find a session in the sidebar
2. Click it
3. Verify the detail view updates
```

---

## Troubleshooting

### "Permission denied" errors
- Re-check Screen Recording and Accessibility permissions
- Restart Terminal/agent after granting permissions

### Screenshots are black
- Screen Recording permission not granted
- The app window is minimized

### Can't find UI elements
- The app might not be in the foreground
- Try: `tell application "Smithers" to activate` first

### OCR not finding text
- Text might be too small or low contrast
- Try taking a screenshot and examining it manually

---

## MCP Config Location

The MCP servers are configured in:
```
~/.config/claude-code/mcp.json
```

Current configuration:
```json
{
  "mcpServers": {
    "macos-automator": {
      "command": "npx",
      "args": ["-y", "@steipete/macos-automator-mcp@latest"]
    },
    "mac-commander": {
      "command": "node",
      "args": ["/Users/williamcory/.local/share/mcp-servers/mac-commander/build/index.js"]
    }
  }
}
```

---

## Quick Reference: MCP Tools

### macos-automator Tools
| Tool | Description |
|------|-------------|
| `execute_script` | Run AppleScript or JXA code |
| `get_scripting_tips` | Search 200+ automation recipes |
| `accessibility_query` | Query/interact with UI elements |

### mac-commander Tools
| Tool | Description |
|------|-------------|
| `take_screenshot` | Capture screen or region |
| `click` | Click at coordinates |
| `type_text` | Type text with keyboard |
| `find_text` | OCR search for text on screen |
| `find_ui_elements` | Visual detection of buttons, fields, etc. |
| `get_windows` | List open windows |
| `press_key` | Press keyboard shortcuts |
