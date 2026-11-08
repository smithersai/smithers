"""Production discovery follows LemmaScript's whitespace-tolerant verify directive."""
import pathlib
import re

VERIFY = re.compile(r'^[ \t]*//@[ \t]+verify\b', re.M)

def production_sources(app: pathlib.Path):
    return sorted(p for folder in ('src', 'worker', 'scripts') for p in (app / folder).rglob('*.vibe')
                  if VERIFY.search(p.read_text()))
