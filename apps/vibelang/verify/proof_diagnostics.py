"""Dafny diagnostics bound to their actual file, generated line, and source function."""
import pathlib
import re
from sources import dafny_name, enclosing_symbol

KINDS = (
    ('postcondition', r'postcondition could not be proved|possible violation of postcondition of forall statement'),
    ('invariant', r'(?:loop|this) invariant could not be proved'),
    ('assertion', r'assertion might not hold'),
    ('precondition', r'a precondition for this call could not be proved'),
)

def read_diagnostics(output, generated, target, functions, keywords):
    target=pathlib.Path(target).resolve()
    lines=generated.splitlines()
    found=[]
    pattern=r'^(.+?\.dfy)\((\d+),(\d+)\): (Error|Related location):([^\n]*)'
    for match in re.finditer(pattern,output,re.M):
        name,line,column,severity,message=match.groups()
        path=pathlib.Path(name.strip())
        if not path.is_absolute():path=target.parent/path
        path=path.resolve()
        line,column=int(line),int(column)
        symbol=function=source_line=None
        if path==target:
            symbol=enclosing_symbol(lines,line)
            if symbol:
                for candidate in (symbol,re.sub(r'_ensures$', '',symbol)):
                    for number,original in functions:
                        if candidate in {original,dafny_name(original,keywords)}:
                            function,source_line=original,number;break
                    if function is not None:break
        kind=next((kind for kind,pattern in KINDS if re.search(pattern,message)),'other')
        found.append({'file':str(path),'line':line,'column':column,
                      'severity':'error' if severity=='Error' else 'related','message':message.strip(),
                      'kind':kind,'function':function,'symbol':symbol,'source_line':source_line})
    return found
