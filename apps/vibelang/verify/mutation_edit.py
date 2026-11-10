"""Locate edits starting in executable text, preserving annotation anchors inside a multiline match."""
def executable_matches(body, old):
    positions=[]
    start=0
    while True:
        at=body.find(old,start)
        if at < 0: return positions
        line_start=body.rfind('\n',0,at)+1
        if not body[line_start:].lstrip().startswith('//@'):
            positions.append(at)
        start=at+len(old)


FUNCTION_HEAD = r'^(?:export )?function {name}(?:<[^>(]*>)?\('


def function_span(source, fn):
    """The text of top-level function `fn`, up to the next top-level function; generic heads (`f<R extends X>(`) count."""
    import re
    match = re.search(FUNCTION_HEAD.format(name=re.escape(fn)), source, re.M)
    if not match: return None
    following = re.search(FUNCTION_HEAD.format(name=r'\w+'), source[match.end():], re.M)
    end = match.end() + following.start() if following else len(source)
    return match.start(), end


def flatten_imports(text, folder):
    """Mutants sit in one flat folder: each relative `.vibe` import is copied beside them and imported as `./name.vibe`."""
    import re
    dependencies = {}
    def local(match):
        path = (folder / match.group(2)).resolve()
        name = path.name
        if dependencies.setdefault(name, path) != path: raise SystemExit(f'two imports share the file name {name}')
        return f'{match.group(1)}"./{name}"'
    return re.sub(r'(from )"(\.{1,2}/[^"]*\.vibe)"', local, text), dependencies
