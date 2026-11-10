"""Type-only imports of `.vibe` modules outside the verifiable subset, read through VibeLang's emitted declarations.

LemmaScript reads TypeScript. A `.vibe` module with schemas or Effect code is not TypeScript, so a proved module could
not name its types: `import type { Message } from "./main.vibe"` staged a copy of `main.vibe` that does not parse. A
type-only import carries no constant and no contract, only types, and VibeLang's declaration of the module states
those types exactly. A module that parses as TypeScript keeps its staged copy, as before; only one that does not is
read through its declaration. `stage` emits the declarations of the named modules and of everything they import, makes each
relative specifier in them absolute into one emitted tree, and writes `name.vibe.d.ts` beside the importing file, so
a staged module and a flat folder of mutants resolve the import alike. A module also imported for its values keeps its
staged `.vibe.ts` copy, which TypeScript prefers over the declaration."""
import json, pathlib, re, subprocess

TYPE_IMPORT = re.compile(r'^import\s+type\s+\{[^}]*\}\s+from\s+"(\.{1,2}/[^"]*\.vibe)"', re.M)
SPECIFIER = re.compile(r'((?:\bfrom|\bimport\()\s*)"(\.{1,2}/[^"]*?)\.ts"')


def type_imports(text):
    """The relative `.vibe` specifiers `text` imports with `import type { … }` only."""
    return TYPE_IMPORT.findall(text)


def value_imports(text):
    """The relative `.vibe` specifiers `text` imports for values, once per import that is not `import type { … }`."""
    from collections import Counter
    every = Counter(re.findall(r'from "(\.{1,2}/[^"]*\.vibe)"', text))
    every.subtract(Counter(type_imports(text)))
    return [spec for spec, count in every.items() if count > 0]


_parses = {}


def parses_as_typescript(path):
    """Whether the module at `path` is TypeScript syntax, so a staged copy of it can be read. Cached per run."""
    path = pathlib.Path(path).resolve()
    if path not in _parses:
        script = ("const ts=require(process.argv[1]).ts;const f=process.argv[2];"
                  "const s=ts.createSourceFile(f,require('fs').readFileSync(f,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);"
                  "process.stdout.write(String(s.parseDiagnostics.length))")
        ts_morph = pathlib.Path(__file__).resolve().parents[3] / 'packages/lemmascript/node_modules/ts-morph'
        p = subprocess.run(['node', '-e', script, str(ts_morph), str(path)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
        if p.returncode: raise SystemExit(f'Could not parse {path}:\n{p.stdout}')
        _parses[path] = p.stdout.strip() == '0'
    return _parses[path]


def copied_imports(text, folder):
    """The relative `.vibe` specifiers staged as copies: every value import, and a type-only import of a module that
    parses as TypeScript, as before declarations existed."""
    types = [spec for spec in type_imports(text) if parses_as_typescript(pathlib.Path(folder) / spec)]
    return list(dict.fromkeys([*value_imports(text), *types]))


def declared_imports(text, folder):
    """The relative `.vibe` specifiers read through their emitted declaration: type-only imports of a module that is
    not TypeScript syntax (schemas, Effect code)."""
    copied = set(copied_imports(text, folder))
    return [spec for spec in dict.fromkeys(type_imports(text)) if spec not in copied]


def emit(app, sources, out):
    """Emits declarations of `sources` (absolute `.vibe` paths) and their imports under `out`; returns each source's
    declaration path in the tree."""
    app = pathlib.Path(app).resolve(); out = pathlib.Path(out).resolve(); out.mkdir(parents=True, exist_ok=True)
    raw = out / 'raw'; tree = out / 'tree'
    config = out / 'tsconfig.json'
    config.write_text(json.dumps({'extends': str(app / 'tsconfig.json'), 'files': sorted(str(s) for s in sources), 'include': [], 'exclude': [],
                                  'compilerOptions': {'noEmit': False, 'declaration': True, 'emitDeclarationOnly': True, 'outDir': str(raw), 'rootDir': str(app)}}))
    p = subprocess.run([str(app / 'node_modules/.bin/vibelang'), '-p', str(config)], cwd=app, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=600)
    (out / 'emit.log').write_text(p.stdout)
    if p.returncode: raise SystemExit(f'VibeLang could not emit the declarations of {", ".join(sorted(str(s) for s in sources))}:\n{p.stdout}')

    def target(rel):
        stem = rel.name[:-len('.d.ts')]
        return tree / rel.parent / (stem + '.vibe.d.ts' if (app / rel.parent / (stem + '.vibe')).exists() else rel.name)

    for declaration in sorted(raw.rglob('*.d.ts')):
        rel = declaration.relative_to(raw)

        def absolute(match):
            dep = (tree / rel.parent / match.group(2)).resolve()
            source = app / dep.relative_to(tree)
            return match.group(1) + '"' + str(dep) + ('.vibe' if source.with_name(source.name + '.vibe').exists() else '.ts') + '"'

        path = target(rel); path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(SPECIFIER.sub(absolute, declaration.read_text()))
    found = {}
    for source in sources:
        rel = pathlib.Path(source).relative_to(app)
        path = tree / rel.parent / (rel.name + '.d.ts')
        if not path.exists(): raise SystemExit(f'VibeLang emitted no declaration for {source}')
        found[pathlib.Path(source)] = path
    return found


def stage(app, wanted, out):
    """`wanted` maps a file to write (`…/name.vibe.d.ts`) to the `.vibe` source it declares; writes each unless a staged
    `.vibe.ts` copy of the same module sits beside it."""
    wanted = {pathlib.Path(k): pathlib.Path(v) for k, v in wanted.items() if not pathlib.Path(str(k)[:-len('.d.ts')] + '.ts').exists()}
    if not wanted: return []
    emitted = emit(app, set(wanted.values()), out)
    for path, source in wanted.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(emitted[source].read_text())
    return sorted(wanted)
