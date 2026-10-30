---
title: "Plugin manifests"
description: "How a plugin declares views, slots, commands and keybindings as data in plugin.json, what the loader checks, the refusal reasons, and the PluginHost contract a plugin's UI runs through."
sidebar:
  order: 4
---

A plugin manifest is a `plugin.json` file: data a host reads without running
any plugin code. It names the plugin, the flows it uses or owns, the
capabilities it may hold, and what it contributes to the app shell. The
loader turns a set of manifests into one `Contributions` value the host draws
from, and refuses each manifest it cannot load with a typed reason.

```
plugin.json ─ Manifest.decode ─▶ Manifest ─┐
plugin.json ─ Manifest.decode ─▶ Manifest ─┼─ Load.load(hostFacts) ─▶ { contributions, refused }
plugin.json ─ Manifest.decode ─▶ Refusal  ─┘
```

## A manifest

The queue plugin's manifest, trimmed to one event and one key:

```json
{
  "apiVersion": 1,
  "id": "queue",
  "version": "0.1.0",
  "title": "Queue",
  "description": "Everything that waits on you, one item at a time.",
  "requires": { "api": "^1.0.0" },
  "capabilities": [],
  "uses": ["run/answer"],
  "$defs": {
    "Option": {
      "type": "object",
      "properties": { "index": { "type": "integer", "minimum": 0, "maximum": 8 } },
      "required": ["index"],
      "additionalProperties": false
    }
  },
  "contributes": {
    "views": [{
      "id": "queue/queue",
      "title": "Queue",
      "scope": "app",
      "path": "",
      "sizes": ["full"],
      "minimum": "member",
      "reads": ["core/waits"],
      "render": { "kind": "component", "export": "Queue" },
      "events": [{
        "name": "option",
        "payload": { "$ref": "#/$defs/Option" },
        "flow": "run/answer",
        "args": { "runId": "$item.runId", "value": "$item.options[$event.index]" }
      }]
    }],
    "keybindings": [{
      "key": "digit",
      "event": "option",
      "fields": { "index": "$key.index" },
      "when": "view == queue/queue && item.question && !focus.input"
    }]
  }
}
```

Pressing `2` sends `option` with `index` 1, and the host binds `value` to the
selected row's `options[1]`. The full fixture is
`test/fixtures/queue.plugin.json`.

## Decoding

`Manifest.decode` copies the input as bounded, inert JSON and decodes it with
unknown fields refused. A union entry that carries both alternatives, such as a
keybinding with both `command` and `event`, refuses too. The refusal names the
field: `contributes.views[0].scope`. `Manifest.parse` takes the file's text and
applies the 64 KiB limit before parsing.

## Three grammars

Nothing in a manifest is evaluated as code. Three closed grammars cover what a
host fills or tests:

- **Bindings** (`Bind`): an arg is a JSON literal, or a reference rooted at
  `$item` (the selected row), `$event` (the event's payload) or `$key` (the key
  pressed), followed by at most four `.name`, `[n]` or `[$event.name]`
  segments.
- **Conditions** (`When`): `view == <plugin>/<name>`, `item.<field>` and
  `focus.input`, each optionally negated with `!`, joined by `&&`. There is no
  `||` and no parentheses.
- **Keys** (`Keys`): one or two strokes, each `mod+`, `ctrl+`, `alt+` or `shift+`
  followed by a letter, a digit, `digit` (any of 1 to 9), `enter`, `escape`,
  `tab`, `space`, an arrow, `/`, `?`, `[` or `]`. `mod` is Meta on a Mac and
  Control elsewhere.

## What the loader checks

`Load.load` never fails. It refuses a bad plugin and loads the rest:

| Reason                              | Refused when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid`                           | The manifest does not decode, including a `RelativePath` that could leave the plugin root; a contribution id lacks the `<plugin>/` prefix; a reference, `when` or key is outside its grammar; a reference's whole path is not declared by the view's row schemas or the event's payload (`[n]` steps into `items`); a literal arg fails the flow's payload property, or a required payload field is left unfilled; a keybinding names no declared command, view, event or payload field, or a field value (every digit `$key.index` can fill included) fails the event's payload; `$key.index` is bound without a `digit` key; command args bind or fail the flow's payload; `userOnly` is not exactly the owned flows that are not model-invocable; a view reads a query the plugin may not read. |
| `range_unreadable`, `incompatible`  | `requires.api` or a `requires.plugins` range cannot be read, or is not met.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `conflict`                          | Two plugins share an id (both refused); an id, event or slash name is taken twice; an owned flow is a system flow, is in the catalog, or has another owner; `shell.header` would hold more than 6 entries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `missing_dependency`, `cycle`       | A required plugin is absent, refused or behind a cycle; the requirements form a cycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `reserved`                          | The plugin id, a contribution's first segment or an owned flow's first segment is a core namespace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `unsupported_point`                 | A non-empty point the host does not fold, owned flows on a host without `flows`, or a `component` render outside a built-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `undeclared_use`                    | A `uses` flow is unknown, or a contribution names a flow it neither owns nor uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `capability_exceeded`               | A used or owned flow needs a capability outside the plugin's `capabilities`, or the tier may not declare one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `minimum_below_flow`                | A view's or command's `minimum` is below a flow it dispatches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `schema_unresolved`, `secret_field` | A JSON Schema is outside the closed subset (`pattern` included, so no plugin regular expression runs), or would collect a secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

`stale_head` and `credential_input` belong to repository snapshots and module
admission, which hosts check; the loader never reports them.

Refusals are ordered by plugin id and never carry a manifest value other than
an id, so they are safe to log and show.

## The host contract

A plugin's UI reads and acts through `PluginHost`, which the app implements:
`query` returns a `Live` source of a declared query's rows (asked with
`params` when the query takes them, such as a repository), `select` and
`propose` drive the host's action strip, `dispatch` runs an event whose flow is
not person-only, `open` opens a declared view, and `events` streams the local
events the keymap delivered to a view. An event whose flow is person-only is
never dispatched by plugin code: the host draws it in its action strip and the
person's press runs it.
