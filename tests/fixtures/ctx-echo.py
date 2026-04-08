"""Echoes ctx.input.topic back as a static payload."""
import json
import sys

ctx = json.loads(sys.stdin.read())
topic = ctx.get("input", {}).get("topic", "unknown")

print(json.dumps({
    "kind": "element",
    "tag": "smithers:workflow",
    "props": {"name": "ctx-echo"},
    "rawProps": {"name": "ctx-echo"},
    "children": [{
        "kind": "element",
        "tag": "smithers:task",
        "props": {"id": "echo"},
        "rawProps": {
            "id": "echo",
            "output": "outputA",
            "__smithersKind": "static",
            "__smithersPayload": {"value": len(topic)},
        },
        "children": [],
    }],
}))
