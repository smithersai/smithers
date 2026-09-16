"""Export tracked prototype fragments as standalone, offline design documents."""
from __future__ import annotations

import argparse
import html
import importlib.util
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TITLES = {
    "start": "Five repository jobs",
    "issues-setup": "Issue handling setup",
    "issue-work": "One issue, independent flows",
    "evals": "Flow evals",
    "ai-check-setup": "AI check setup",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", type=Path, required=True,
                        help="Installed visualize skill scripts/render.py")
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("visualize_render", args.renderer)
    if spec is None or spec.loader is None:
        raise SystemExit("Cannot load the renderer")
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    shell = (ROOT / "shell.html").read_text()
    bridge = (ROOT / "bridge.js").read_text()
    for source in sorted((ROOT / "sources").glob("*.html")):
        exported = renderer.render(source)
        match = re.search(r'srcdoc="(.*?)"></iframe>', exported, re.S)
        if match is None:
            raise SystemExit("Renderer output does not contain its expected sandbox")
        inner = html.unescape(match.group(1))
        # These prototypes need no tooltips or icon library. Remove the helper's
        # remote optional scripts so the document can open fully offline.
        inner = re.sub(r'<script\b[^>]*src="https://[^"]+"[^>]*>\s*</script>', "", inner)
        inner = re.sub(r'<i data-lucide="[^"]+" aria-hidden="true"></i>', "", inner)
        inner = inner.replace("<body>", "<body><script>" + bridge + "</script>", 1)
        # Prevent script-end text in srcdoc JSON from terminating the outer script.
        payload = json.dumps(inner, ensure_ascii=False).replace("</", "<\\/")
        document = shell.replace("__TITLE__", html.escape(TITLES[source.stem]))
        document = document.replace("__FRAME_JSON__", payload)
        destination = ROOT / (source.stem + ".html")
        destination.write_text(document)
        print(destination.relative_to(ROOT.parent))


if __name__ == "__main__":
    main()
