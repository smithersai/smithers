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
