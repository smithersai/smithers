"""A `spec function` (VIP-43) in LemmaScript's annotation language.

VibeLang erases a spec function from emitted JavaScript and declarations, and rejects any reference to it outside a
proof context (EK4310). LemmaScript reads TypeScript, so a staged copy writes each one as VibeLang's own lowering does
(Appendix F, "The lowering file"): the declaration as `export function`, with `spec` removed. The rewrite keeps every
line where it was, so reports give the `.vibe` line."""
import re

SPEC_FUNCTION = re.compile(r'^([ \t]*)spec[ \t]+function\b', re.M)


def lower(text: str) -> str:
    """`text` with each `spec function` written as `export function`. A spec function takes no modifier (EK4302), so
    the form always starts its line."""
    return SPEC_FUNCTION.sub(lambda m: f'{m.group(1)}export function', text)
