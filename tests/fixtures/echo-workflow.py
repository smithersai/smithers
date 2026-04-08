"""Minimal Python workflow that outputs a static task."""
import json
import sys

ctx = json.loads(sys.stdin.read())
print(json.dumps({
    "kind": "element",
    "tag": "smithers:workflow",
    "props": {"name": "echo"},
    "rawProps": {"name": "echo"},
    "children": [{
        "kind": "element",
        "tag": "smithers:task",
        "props": {"id": "echo"},
        "rawProps": {
            "id": "echo",
            "output": "outputA",
            "__smithersKind": "static",
            "__smithersPayload": {"value": 42},
        },
        "children": [],
    }],
}))
