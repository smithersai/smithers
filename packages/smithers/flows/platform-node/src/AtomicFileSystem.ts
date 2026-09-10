/**
 * Descriptor-relative filesystem operations for the capability kernel.
 *
 * Node does not expose `openat(2)` / `renameat(2)`. This adapter delegates
 * each operation to a small POSIX helper. The helper opens the filesystem
 * root once, walks every component with `O_NOFOLLOW`, and performs the final
 * syscall relative to a pinned parent descriptor. Missing Python/POSIX
 * primitives are reported as a typed, fail-closed platform error.
 *
 * **Host prerequisite.** A POSIX host with CPython 3 installed at
 * {@link defaultExecutable} (`/usr/bin/python3`), whose `os` module supports
 * `O_NOFOLLOW`, `O_DIRECTORY`, and `dir_fd` for `open`, `mkdir`, `readlink`,
 * `rename`, `rmdir`, `stat`, and `unlink`. A host that installs its
 * interpreter somewhere else configures the absolute path through
 * {@link layerWith}. **Windows is not supported**: it has none of these
 * primitives, and `/usr/bin/python3` does not exist there, so every operation
 * fails closed rather than falling back to a path-based call.
 *
 * The interpreter is addressed by absolute path and never looked up through
 * `PATH`, and the helper runs isolated from the ambient environment — an inert
 * working directory, an empty environment, no module search path entry for the
 * cwd or `PYTHONPATH`, and UTF-8 pinned for the request, the response, and the
 * filesystem encoding — so neither the workspace it confines nor the
 * environment it was started under can change what it executes or which path
 * it addresses.
 *
 * Both directions of the helper protocol are length-framed and bounded by
 * {@link defaultLimits}, so neither a large file nor a malfunctioning helper
 * can make the host allocate without limit.
 *
 * **Cost.** Each ordinary operation or bounded read batch starts one CPython
 * helper. Batches amortize interpreter startup over up to 128 operations on
 * one pinned root. {@link Options.concurrency} exists because without a
 * ceiling an `Effect.forEach(..., { concurrency: "unbounded" })` over fifty
 * paths starts fifty interpreters at once. Batch a wide fan-out, and prefer one
 * recursive `readDirectory` (one fork for the whole tree) to a read per entry.
 * {@link Options.timeoutMs} is the wall-clock backstop underneath all of it.
 *
 * @since 0.1.0
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Layer, Option, PlatformError, Result, Semaphore } from "effect"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { availableParallelism } from "node:os"
import { basename, dirname, isAbsolute, join, relative } from "node:path"

const helper = String.raw`
import base64, errno, hashlib, json, os, stat, sys

PROTOCOL = "flows-atomic/1"
# The header is read one byte at a time, so it is capped before anything is
# allocated for it. The hard cap bounds what any declared limit may claim,
# whatever the host asked for.
HEADER_CAP = 256
HARD_CAP = 256 * 1024 * 1024
MESSAGE_CAP = 4096
CHUNK = 65536
ENTRY_CAP = 100000
# A recursive removal opens one descriptor per level, so the depth is bounded
# rather than left to the process descriptor limit.
REMOVE_DEPTH_CAP = 512
# Glob grammar bounds. Brace expansion is multiplicative, so both the pattern
# and the number of alternatives it produces are capped before any walking.
BRACE_CAP = 64
PATTERN_CAP = 4096
BATCH_CAP = 128

# Glob segment token kinds, and the marker for a "**" segment.
STAR = 0
ANY = 1
CLASS = 2
LITERAL = 3
GLOBSTAR = object()

# The syscall the operation in flight would name in a Node ErrnoException.
# Effect's own Node adapter sets syscall on every system error it reports, so a
# caller that switches on it reads a populated field from either adapter. It
# names the syscall the OPERATION is, narrowed where an operation has two
# answers (remove_at picks unlink or rmdir); it is not a claim that a given
# failure is attributed to the same call Node would attribute it to, which
# depends on which of an operation's several syscalls raised.
SYSCALLS = {
    "readFile": "open", "readFileString": "open", "digest": "open",
    "writeFile": "open", "writeFileString": "open",
    "exists": "access", "stat": "stat", "readLink": "readlink",
    "realPath": "realpath", "makeDirectory": "mkdir",
    "readDirectory": "scandir", "glob": "scandir",
    "remove": "unlink", "rename": "rename",
}
SYSCALL = [None]

required_dir_fd = (os.open, os.mkdir, os.readlink, os.rename, os.rmdir, os.stat, os.unlink)
if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
    raise OSError(errno.ENOTSUP, "O_NOFOLLOW/O_DIRECTORY unavailable")
if any(function not in os.supports_dir_fd for function in required_dir_fd):
    raise OSError(errno.ENOTSUP, "descriptor-relative POSIX operations unavailable")

NOFOLLOW = os.O_NOFOLLOW
DIRECTORY = os.O_DIRECTORY
EPROTO = getattr(errno, "EPROTO", errno.EINVAL)

# Effect's FileSystem.OpenFlag translated to POSIX open flags. O_TRUNC is
# deliberately absent: truncating is a mutation, so it has to happen on the
# already-opened descriptor after the hard-link and file-kind checks, never as
# a side effect of open() itself. A read-only flag stays read-only, so writing
# through it fails with EBADF exactly as it does on Node.
OPEN_FLAGS = {
    "r": os.O_RDONLY,
    "r+": os.O_RDWR,
    "w": os.O_WRONLY | os.O_CREAT,
    "wx": os.O_WRONLY | os.O_CREAT | os.O_EXCL,
    "w+": os.O_RDWR | os.O_CREAT,
    "wx+": os.O_RDWR | os.O_CREAT | os.O_EXCL,
    "a": os.O_WRONLY | os.O_CREAT | os.O_APPEND,
    "ax": os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_APPEND,
    "a+": os.O_RDWR | os.O_CREAT | os.O_APPEND,
    "ax+": os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_APPEND,
}
TRUNCATED_FLAGS = ("w", "w+")

class BadArgument(Exception):
    """Caller input rejected before any operation runs. Node rejects an unknown
    open flag the same way, and Effect reports it as BadArgument rather than as
    a system error."""

def file_type(mode):
    """Effect's FileSystem.File.Type. Reporting the precise kind is part of the
    contract: a caller that has to tell a FIFO from a socket cannot be handed
    one catch-all name, and every value here is one Effect declares."""
    if stat.S_ISREG(mode): return "File"
    if stat.S_ISDIR(mode): return "Directory"
    if stat.S_ISLNK(mode): return "SymbolicLink"
    if stat.S_ISFIFO(mode): return "FIFO"
    if stat.S_ISSOCK(mode): return "Socket"
    if stat.S_ISBLK(mode): return "BlockDevice"
    if stat.S_ISCHR(mode): return "CharacterDevice"
    return "Unknown"

def parts(path):
    if not os.path.isabs(path):
        raise OSError(errno.EINVAL, "atomic path must be absolute", path)
    return [part for part in path.split(os.sep) if part not in ("", ".")]

def parent(root, path, create=False, mode=0o777):
    values = parts(path)
    if not values:
        raise OSError(errno.EPERM, "refusing filesystem root", path)
    fd = os.dup(root)
    try:
        for name in values[:-1]:
            if name == "..":
                raise OSError(errno.EPERM, "parent traversal denied", path)
            try:
                nxt = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, mode, dir_fd=fd)
                except FileExistsError:
                    # A competing recursive mkdir may have won. Reopen with
                    # the same flags so a file or symlink still fails closed.
                    pass
                nxt = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd, values[-1]
    except BaseException:
        os.close(fd)
        raise

def entry_stat(root, path):
    """lstat of the final component, relative to the pinned parent descriptor.
    A metadata question must not OPEN the entry: opening a FIFO, a device, or a
    socket has side effects the caller never asked for, and for a socket it
    simply fails. The parent is still pinned, so the answer is about the entry
    the walk reached, not about a name re-resolved from the top."""
    directory, name = parent(root, path)
    try:
        return os.stat(name, dir_fd=directory, follow_symlinks=False)
    finally:
        os.close(directory)

def open_file(root, path, flags, mode=0o666):
    """The single final-open path, used only where the CONTENT of a regular
    file is read or written. The confinement contract is stated once: the open
    is relative to the pinned parent descriptor, O_NOFOLLOW refuses a symlink,
    O_NONBLOCK stops a planted FIFO from parking the helper forever in open(),
    and the descriptor is then required to be a regular file with one link
    before the caller can act on it. Requiring the kind on the DESCRIPTOR (not
    on a name that could be swapped afterwards) is what keeps a FIFO, a device,
    a socket, or a directory out of every content read and write."""
    directory, name = parent(root, path)
    try:
        fd = os.open(name, flags | NOFOLLOW | os.O_NONBLOCK, mode, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        info = os.fstat(fd)
        if stat.S_ISDIR(info.st_mode):
            raise OSError(errno.EISDIR, "path is a directory", path)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(errno.EPERM,
                          "only regular files carry content: refusing a " + file_type(info.st_mode),
                          path)
        if info.st_nlink > 1:
            raise OSError(errno.EPERM, "hard-linked files cannot be confined", path)
    except BaseException:
        # fstat itself can fail, and every refusal above owns the descriptor,
        # so the close belongs here rather than after a successful check.
        os.close(fd)
        raise
    return fd

def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def unchanged(before, after, path):
    if fingerprint(before) != fingerprint(after):
        raise OSError(errno.EBUSY, "entry changed during measurement", path)

def list_dir(root, path, recursive, budget, with_kind=False, prune=None, stable=False):
    if not parts(path):
        fd = os.dup(root)
    else:
        directory, name = parent(root, path)
        try:
            fd = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=directory)
        finally:
            os.close(directory)
    # Include the response envelope and the list delimiters up front. Each
    # retained name is then charged by its exact JSON encoding, not by its raw
    # filesystem bytes: quotes, backslashes, and control characters expand in
    # JSON and must not turn a nominally bounded listing into a much larger
    # allocation.
    total = [32]
    entries = [0]
    def walk(current, prefix=""):
        before = os.fstat(current) if stable else None
        # Listing NAMES a directory entry; it never resolves one. A symlink is
        # reported by name and never descended into, so a listing cannot leave
        # the pinned root and cannot be made to by planting a link. Refusing
        # the whole listing instead would buy no confinement and would make
        # every recursive list and glob over a real workspace fail.
        result = []
        names = []
        # os.listdir materializes the whole directory before the loop can
        # enforce any bound. scandir is incremental, so a hostile wide
        # directory is refused after ENTRY_CAP names rather than allocated in
        # full; only the bounded batch is then sorted for deterministic output.
        with os.scandir(current) as iterator:
            for item in iterator:
                entry = item.name
                relative = os.path.join(prefix, entry) if prefix else entry
                info = item.stat(follow_symlinks=False)
                # The lstat makes S_ISDIR false for a link to a directory, so
                # this descends only into real subdirectories. The kind travels
                # with the name because glob needs it for directory-only
                # patterns and for pruning without a second metadata lookup.
                directory = stat.S_ISDIR(info.st_mode)
                # An excluded entry consumes none of the retained-entry or
                # response bounds. A directory is decided here so its contents
                # are never visited in the first place.
                if prune is not None and prune(relative, directory):
                    continue
                entries[0] += 1
                if entries[0] > ENTRY_CAP:
                    raise OSError(errno.EFBIG, "directory listing has too many entries", path)
                # Charged before the name is retained, so a tree large enough
                # to exhaust the response budget is refused instead of
                # accumulated.
                total[0] += len(json.dumps(relative, ensure_ascii=False).encode("utf-8")) + 1
                if total[0] > budget:
                    raise OSError(errno.EFBIG, "directory listing exceeds the response limit", path)
                names.append((entry, relative, directory))
        names.sort(key=lambda item: item[0])
        for entry, relative, directory in names:
            result.append((relative, directory))
            if recursive and directory:
                child = os.open(entry, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=current)
                try:
                    result.extend(walk(child, relative))
                    if stable:
                        unchanged(os.fstat(child), os.stat(entry, dir_fd=current, follow_symlinks=False), relative)
                finally:
                    os.close(child)
        if stable:
            unchanged(before, os.fstat(current), prefix)
        return result
    try:
        found = walk(fd)
    finally:
        os.close(fd)
    return found if with_kind else [name for name, _ in found]

def split_alternatives(body):
    """The top-level members of a brace body, or None when there is no
    top-level comma. "{a}" is literal text to a globber, not a one-member
    alternation, so the caller leaves it alone."""
    members = []
    depth = 0
    current = []
    for char in body:
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        if char == "," and depth == 0:
            members.append("".join(current))
            current = []
        else:
            current.append(char)
    if not members:
        return None
    members.append("".join(current))
    return members

def refuse_brace_range(body):
    """Refuses a brace body this grammar does not implement.

    A body with no top-level comma is literal text here, so "{1..3}" would
    quietly match a file literally named "{1..3}" while the globber this
    adapter mirrors expands it to 1, 2, and 3. Answering a DIFFERENT question
    from the one the caller asked is the failure this whole path exists to
    stop, and it is worse in an exclude, where it hands back paths the caller
    forbade. So it is refused rather than reinterpreted."""
    if ".." in body:
        raise BadArgument("glob brace ranges are not implemented: {%s}" % body)

def expand_braces(pattern):
    """A pattern's brace alternations expanded into whole patterns.

    The bound includes pending work because checking only finished leaves lets
    a long chain consume one interpreter frame per group before producing its
    first leaf. An UNBALANCED brace is literal text rather than an error: that
    is what the globber this adapter replaces does with it, and it matches
    nothing."""
    out = []
    queue = [pattern]
    while queue:
        text = queue.pop()
        index = 0
        depth = 0
        start = -1
        expanded = False
        while index < len(text):
            char = text[index]
            if char == "{":
                if depth == 0:
                    start = index
                depth += 1
            elif char == "}" and depth > 0:
                depth -= 1
                if depth == 0:
                    body = text[start + 1:index]
                    members = split_alternatives(body)
                    if members is None:
                        refuse_brace_range(body)
                        # A group with no top-level comma is literal text, but a
                        # group INSIDE it can still be an alternation: the
                        # native globber expands "{{a,b}}" to "{a}" and "{b}".
                        # So the scan resumes just inside this group instead of
                        # continuing past it.
                        index = start + 1
                        depth = 0
                        start = -1
                        continue
                    for member in members:
                        queue.append(text[:start] + member + text[index + 1:])
                    expanded = True
                    break
            index += 1
        if expanded:
            if len(out) + len(queue) > BRACE_CAP:
                raise BadArgument("glob pattern expands past %d alternatives" % BRACE_CAP)
            continue
        if len(out) >= BRACE_CAP:
            raise BadArgument("glob pattern expands past %d alternatives" % BRACE_CAP)
        out.append(text)
    return out

def class_token(segment, index):
    """A "[...]" character class, and where the segment continues after it."""
    cursor = index + 1
    negated = False
    if cursor < len(segment) and segment[cursor] in ("!", "^"):
        negated = True
        cursor += 1
    ranges = []
    first = True
    while cursor < len(segment):
        char = segment[cursor]
        # A "]" in the FIRST position is a member, not the terminator, which is
        # what makes "[]]" a class holding one bracket.
        if char == "]" and not first:
            return (CLASS, negated, tuple(ranges)), cursor + 1
        # "[[:digit:]]" is a POSIX class the globber this adapter mirrors
        # expands. Reading it as the members "[", ":", "d" ... would answer a
        # different question from the one asked, so it is refused instead.
        if char == "[" and segment[cursor + 1:cursor + 2] == ":":
            raise BadArgument("glob POSIX character classes are not implemented: %s" % segment)
        first = False
        if cursor + 2 < len(segment) and segment[cursor + 1] == "-" and segment[cursor + 2] != "]":
            ranges.append((char, segment[cursor + 2]))
            cursor += 3
        else:
            ranges.append((char, char))
            cursor += 1
    # Never closed, so the bracket is an ordinary character. "*.tx[t" matches
    # nothing rather than failing, exactly as the native globber reads it.
    return (LITERAL, "["), index + 1

def compile_segment(segment):
    """One path segment as a token list.

    Tokens rather than a regular expression: "*" compiles to an independent
    greedy "[^/]*" in a regex, so a pattern of repeated "*<char>" fragments
    costs exponential backtracking. match_segment below is the classic
    single-star backtracking matcher, which is O(len(name) * len(tokens))."""
    tokens = []
    index = 0
    while index < len(segment):
        char = segment[index]
        if char == "*":
            # Consecutive stars inside one segment are one star: "a**b" is "a*b".
            if not tokens or tokens[-1][0] != STAR:
                tokens.append((STAR,))
        elif char == "?":
            tokens.append((ANY,))
        elif char == "[":
            token, index = class_token(segment, index)
            # The native matcher reduces a singleton positive class to literal
            # text before it removes dot path parts. Without the same collapse,
            # "[.]" stays magic and asks the walk for an impossible "." entry.
            if (token[0] == CLASS and not token[1] and len(token[2]) == 1
                    and token[2][0][0] == token[2][0][1]):
                token = (LITERAL, token[2][0][0])
            tokens.append(token)
            continue
        else:
            tokens.append((LITERAL, char))
        index += 1
    return tokens

def token_matches(token, char):
    kind = token[0]
    if kind == LITERAL:
        return char == token[1]
    if kind == ANY:
        return True
    inside = any(low <= char <= high for low, high in token[2])
    return inside != token[1]

def allows_leading_dot(tokens):
    """Whether a segment SPELLS its leading dot rather than wildcarding it.

    A literal "." does, and so does a POSITIVE character class that contains
    one: the native globber matches ".dot.txt" with "[.]dot.txt". A "*", a "?",
    and a class that does not spell the dot do not, which is the whole dotfile
    rule. A NEGATED class is the case worth naming: "[!a]" happens to match a
    dot, but the globber still keeps it out of a leading one, so asking whether
    the class MATCHES the dot is the wrong question."""
    if not tokens:
        return False
    first = tokens[0]
    if first[0] == LITERAL:
        return first[1] == "."
    return (first[0] == CLASS and not first[1]
            and any(low <= "." <= high for low, high in first[2]))

def match_segment(compiled, text):
    tokens, allows_dot = compiled
    # A leading dot is matched only by a pattern that spells one. A wildcard
    # never reaches into a dotfile, which is the rule the native globber
    # applies and the reason "**/*.txt" skips ".hidden/in.txt".
    if text.startswith(".") and not allows_dot:
        return False
    count = len(tokens)
    length = len(text)
    position = 0
    cursor = 0
    star = -1
    mark = 0
    while cursor < length:
        if position < count and tokens[position][0] != STAR and token_matches(tokens[position], text[cursor]):
            position += 1
            cursor += 1
        elif position < count and tokens[position][0] == STAR:
            star = position
            mark = cursor
            position += 1
        elif star >= 0:
            mark += 1
            cursor = mark
            position = star + 1
        else:
            return False
    while position < count and tokens[position][0] == STAR:
        position += 1
    return position == count

def parse_pattern(pattern):
    """A brace-free pattern as (segments, directory_only, literal_core, dot_anchor).

    A trailing "/" is not noise: it makes the pattern name directories only,
    which is the whole difference between "**/" and "**"."""
    directory_only = pattern.endswith("/")
    raws = pattern.split("/")
    segments = []
    dot_anchor = False
    for position, raw in enumerate(raws):
        if raw in ("", "."):
            continue
        if raw == "**":
            if not segments or segments[-1] is not GLOBSTAR:
                segments.append(GLOBSTAR)
            continue
        tokens = compile_segment(raw)
        # A class that COLLAPSES to "." is not the same thing as a spelled one.
        # The globber this adapter mirrors drops a spelled "." before it parses
        # the pattern and collapses "[.]" to "." only afterwards, so the
        # collapsed one survives as a segment naming an entry called ".". As the
        # LAST segment it names whatever the segments before it addressed, which
        # is the same shortcut a trailing "**" gets. Anywhere else it names an
        # entry no directory holds, so it stays a segment and matches nothing.
        if (all(token[0] == LITERAL for token in tokens)
                and "".join(token[1] for token in tokens) == "."
                and position == len(raws) - 1):
            dot_anchor = True
            continue
        segments.append((tokens, allows_leading_dot(tokens)))
    trailing = not dot_anchor and bool(segments) and segments[-1] is GLOBSTAR
    core = segments[:-1] if trailing else segments
    literal_core = all(segment is not GLOBSTAR and
                       all(token[0] == LITERAL for token in segment[0])
                       for segment in core)
    return segments, directory_only, literal_core, dot_anchor

def match_segments(segments, directory_only, literal_core, dot_anchor, names, is_dir, anchor):
    """Whether one parsed pattern names one entry.

    The walk over "**" is a reachable-state sweep rather than a backtracking
    search, so the cost is len(names) * len(segments) and never more."""
    if directory_only and not is_dir:
        return False
    # A trailing "**" spans ZERO or more segments, so as a SELECTOR it names the
    # anchor itself as well as everything below it: "nested/**" includes
    # "nested". As an EXCLUDE it does not, which is the native globber's own
    # asymmetry: excluding "nested/**" removes what is below "nested" and leaves
    # the directory entry itself in the result.
    trailing = not dot_anchor and bool(segments) and segments[-1] is GLOBSTAR
    core = segments[:-1] if trailing else segments
    globstar_last = bool(core) and core[-1] is GLOBSTAR
    def advance(index, out):
        while True:
            if index in out:
                return
            out.add(index)
            if index < len(core) and core[index] is GLOBSTAR:
                index += 1
                continue
            return
    def accepts(consumed):
        if consumed == len(names):
            if dot_anchor:
                # A trailing "." names what the segments before it addressed,
                # under the same rule a trailing "**" gets, plus one more: the
                # globber reaches a "." only from a directory it has QUEUED, and
                # a "**" immediately before it queues nothing, so "**/[.]" names
                # nothing while "**/deep/[.]" names the directory. An EXCLUSION
                # has no such reach, because nothing addresses a path for it.
                return anchor and not globstar_last and (is_dir or literal_core)
            if not trailing:
                return True
            # Node stats the joined path when every core segment is literal.
            # That shortcut is why "top.txt/**" names its file anchor while
            # "t*.txt/**" does not, even when both core patterns find it.
            return anchor and (is_dir or literal_core)
        # Only a trailing "**" may span what is left, and it never crosses a
        # dotted segment.
        return trailing and all(not part.startswith(".") for part in names[consumed:])
    states = set()
    advance(0, states)
    if len(core) in states and accepts(0):
        return True
    for position, part in enumerate(names):
        following = set()
        for index in states:
            if index >= len(core):
                continue
            if core[index] is GLOBSTAR:
                # "**" spans whole segments but never crosses into a dotted one.
                if not part.startswith("."):
                    advance(index, following)
            elif match_segment(core[index], part):
                advance(index + 1, following)
        states = following
        if not states:
            return False
        if len(core) in states and accepts(position + 1):
            return True
    return False

EXTGLOB_OPERATORS = ("?", "*", "+", "@", "!")

def refuse_unimplemented_pattern(pattern):
    """Refuses the syntax this grammar reads differently from the globber it
    mirrors.

    An extglob group means something to the native globber. Reading it as
    ordinary characters does not fail, it answers a different question: as a
    selector it silently returns the wrong set, and as an exclusion it hands
    the caller the very paths it forbade. Backslashes are normalized separately
    by relative_pattern because Node gives them context-sensitive semantics."""
    for segment in pattern.split("/"):
        index = 0
        while index < len(segment):
            char = segment[index]
            if char == "[":
                cursor = index + 1
                if cursor < len(segment) and segment[cursor] in ("!", "^"):
                    cursor += 1
                first = True
                while cursor < len(segment):
                    if segment[cursor] == "]" and not first:
                        index = cursor + 1
                        break
                    first = False
                    cursor += 1
                else:
                    # An unclosed bracket is an ordinary character, so syntax
                    # after it still has to be inspected.
                    index += 1
                continue
            if char in EXTGLOB_OPERATORS and segment[index + 1:index + 2] == "(":
                raise BadArgument("glob extended patterns are not implemented: %s" % pattern)
            index += 1

class GlobMatcher:
    """A compiled glob pattern, with its brace alternations expanded.

    "anchor" is False for an exclusion, where a trailing "**" names what is
    below a directory but not the directory entry itself."""
    def __init__(self, pattern, anchor=True):
        if pattern is None:
            self.alternatives = []
            self.anchor = anchor
            return
        if len(pattern) > PATTERN_CAP:
            raise BadArgument("glob pattern is longer than %d characters" % PATTERN_CAP)
        refuse_unimplemented_pattern(pattern)
        self.alternatives = [parse_pattern(expanded) for expanded in expand_braces(pattern)]
        self.anchor = anchor
    def matches(self, names, is_dir):
        for segments, directory_only, literal_core, dot_anchor in self.alternatives:
            if match_segments(segments, directory_only, literal_core, dot_anchor, names, is_dir, self.anchor):
                return True
        return False

def relative_pattern(pattern, root_path, exclusion=False):
    """A pattern rewritten relative to the glob root.

    Both relpath and normpath drop a trailing slash, so it is put back: it is
    the directory-only marker. Excludes go through this too, which is what
    makes an ABSOLUTE exclude the caller passed apply to the same names the
    selecting pattern is matched against."""
    if len(pattern) > PATTERN_CAP:
        raise BadArgument("glob pattern is longer than %d characters" % PATTERN_CAP)
    absolute = os.path.isabs(pattern)
    directory_only = pattern.endswith("/")
    # Node's POSIX globber drops backslashes from absolute selectors and from
    # every exclusion, leaving any following magic active. A relative selector
    # containing one matches nothing. The public adapter supplies an absolute
    # selector, while direct protocol callers still receive the native empty
    # answer for the relative form.
    if "\\" in pattern:
        if not exclusion and not absolute:
            return None
        pattern = pattern.replace("\\", "")
    relative = (os.path.relpath(pattern, root_path) if absolute
                else os.path.normpath(pattern))
    if relative == ".":
        relative = ""
    return relative + "/" if directory_only else relative

def remove_at(directory, name, recursive):
    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode):
        raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", name)
    if not stat.S_ISDIR(info.st_mode):
        SYSCALL[0] = "unlink"
        os.unlink(name, dir_fd=directory)
        return
    if not recursive:
        SYSCALL[0] = "rmdir"
        os.rmdir(name, dir_fd=directory)
        return
    remove_tree(directory, name)

def remove_tree(directory, name):
    """Removes a directory and everything below it, iteratively.

    The bounds are the point. Recursion held one open descriptor per level and
    listed each directory with os.listdir, so a deep tree hit the interpreter's
    recursion limit or the process descriptor limit and a wide one was
    materialized in full: both failed AFTER deleting part of the tree, with no
    stated policy. The policy is stated here instead. Depth is bounded by
    REMOVE_DEPTH_CAP and the total number of entries visited by ENTRY_CAP, and
    the count is checked DURING each scandir, so a hostile wide directory is
    refused after ENTRY_CAP names rather than allocated whole. One directory's
    names are read before any of its entries is unlinked, because unlinking
    from a directory while iterating it is not defined; the cap is what bounds
    the names held across the whole walk. Progress is still partial on refusal —
    entries already unlinked stay unlinked — and every descriptor is closed on
    every exit, refusal and interruption alike."""
    visited = [0]
    stack = []
    try:
        stack.append([directory, name, os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=directory), None])
        while stack:
            frame = stack[-1]
            holder, entry, fd, pending = frame
            if pending is None:
                pending = []
                with os.scandir(fd) as iterator:
                    for item in iterator:
                        visited[0] += 1
                        if visited[0] > ENTRY_CAP:
                            raise OSError(errno.EFBIG, "directory tree has too many entries to remove", name)
                        pending.append((item.name, item.is_symlink(), item.is_dir(follow_symlinks=False)))
                frame[3] = pending
            descended = False
            while pending:
                child, link, directory_child = pending.pop()
                if link:
                    raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", child)
                if directory_child:
                    if len(stack) >= REMOVE_DEPTH_CAP:
                        raise OSError(errno.EFBIG, "directory tree is deeper than the removal limit", name)
                    stack.append([fd, child, os.open(child, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=fd), None])
                    descended = True
                    break
                SYSCALL[0] = "unlink"
                os.unlink(child, dir_fd=fd)
            if descended:
                continue
            stack.pop()
            os.close(fd)
            SYSCALL[0] = "rmdir"
            os.rmdir(entry, dir_fd=holder)
    finally:
        for _, _, fd, _ in stack:
            os.close(fd)

def rejection(error):
    number = getattr(error, "errno", None)
    return {"ok": False,
            "code": errno.errorcode.get(number) if isinstance(number, int) else None,
            "syscall": SYSCALL[0], "badArgument": isinstance(error, BadArgument),
            "message": str(error)[:MESSAGE_CAP]}

def open_boundary(path):
    base = os.open(os.sep, os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
        if not parts(path): return os.dup(base)
        directory, name = parent(base, path)
        try: return os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=directory)
        finally: os.close(directory)
    finally: os.close(base)

def root_identity(info):
    return "%d:%d" % (info.st_dev, info.st_ino)

def acquire_root(request):
    # Every request acquires the canonical root component by component, then
    # checks the descriptor against the identity captured at layer composition.
    # O_NOFOLLOW on an absolute open alone would still follow ancestor links.
    batch = request["operation"] == "batch"
    try:
        root = open_boundary(request["boundaryRoot"])
    except OSError as error:
        if batch and not isinstance(error, FileNotFoundError): raise
        raise OSError(errno.EBUSY if batch else errno.EPERM,
                      "atomic root unavailable: " + str(error)) from error
    try:
        if root_identity(os.fstat(root)) != request.get("rootIdentity"):
            raise OSError(errno.EBUSY if batch else errno.EPERM,
                          "atomic root no longer names the authorized descriptor")
        return root
    except BaseException:
        os.close(root)
        raise

def check_root(root, request):
    identity = root_identity(os.fstat(root))
    if identity != request["rootIdentity"]:
        raise OSError(errno.EBUSY, "batch root no longer names the authorized descriptor")
    current = acquire_root(request)
    try:
        if root_identity(os.fstat(current)) != identity:
            raise OSError(errno.EBUSY, "batch root changed during measurement")
    finally: os.close(current)

def main(request, content_limit, response_limit, pinned_root=None):
    operation = request["operation"]
    # Set before anything runs, so a failure inside the walk to the target is
    # still attributed to the syscall the OPERATION names. remove_at narrows it
    # further, because unlink and rmdir are two different answers.
    SYSCALL[0] = SYSCALLS.get(operation)
    options = request.get("options") or {}
    logical_root = request["logicalRoot"]
    def confined(path):
        # realPath returns the canonical boundary spelling. Both that name and
        # the logical workspace alias must round-trip to the SAME pinned root;
        # neither permits following a symlink below its descriptor.
        for base in (logical_root, request["boundaryRoot"]):
            relative = os.path.relpath(path, base)
            if relative != ".." and not relative.startswith(".." + os.sep):
                # The root itself confines to os.sep, whose component list is
                # empty. parent() still refuses destructive root operations.
                return os.sep if relative == "." else os.sep + relative
        raise OSError(errno.EPERM, "path is outside the pinned root", path)
    root = os.dup(pinned_root) if pinned_root is not None else acquire_root(request)
    try:
        if operation == "batch":
            requests = request["requests"]
            batch_limit = request["batchSize"]
            entry_limit = request["batchEntry"]
            if (not isinstance(requests, list) or not 0 < batch_limit <= BATCH_CAP
                    or not 0 < len(requests) <= batch_limit or not 0 < entry_limit <= HARD_CAP):
                raise BadArgument("atomic batch limits are out of range")
            check_root(root, request)
            entries = []
            # The exact final envelope is charged incrementally. No path may
            # consume the response budget reserved for later failure entries.
            total = len(json.dumps({"ok": True, "value": {"rootIdentity": request["rootIdentity"], "entries": []}},
                                  separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
            for index, member in enumerate(requests):
                path = member["path"]
                SYSCALL[0] = SYSCALLS.get(member["operation"])
                try:
                    if member["operation"] not in ("stat", "readDirectory", "glob", "digest"):
                        raise BadArgument("unsupported atomic batch operation")
                    check_root(root, request)
                    target = confined(member["root"] if member["operation"] == "glob" else path)
                    before = entry_stat(root, target) if parts(target) else os.fstat(root)
                    sub = dict(member, boundaryRoot=request["boundaryRoot"], logicalRoot=logical_root)
                    if member["operation"] == "glob": sub["pattern"] = path
                    try:
                        value = main(sub, content_limit, min(entry_limit, response_limit), root)
                        after = entry_stat(root, target) if parts(target) else os.fstat(root)
                    except FileNotFoundError as error:
                        # Initial absence above remains NotFound. Losing an
                        # entry after measurement began is concurrent mutation.
                        raise OSError(errno.EBUSY, "entry disappeared during measurement", path) from error
                    unchanged(before, after, path)
                    check_root(root, request)
                    result = {"ok": True, "value": value}
                    if len(json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) > entry_limit:
                        raise OSError(errno.EFBIG, "batch entry exceeds the response limit", path)
                except Exception as error:
                    result = rejection(error)
                if len(json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) > entry_limit:
                    raise OSError(errno.EFBIG, "batch failure exceeds the entry response limit")
                entry = {"index": index, "path": path, "result": result}
                total += len(json.dumps(entry, separators=(",", ":"), ensure_ascii=False).encode("utf-8")) + (1 if index else 0)
                if total > response_limit:
                    raise OSError(errno.EFBIG, "batch response exceeds the response limit")
                entries.append(entry)
            check_root(root, request)
            # JavaScript orders UTF-16 code units, which differs from Python's
            # code-point ordering for astral names. Persisted identities use JS.
            entries.sort(key=lambda entry: (entry["path"].encode("utf-16-be"), entry["index"]))
            return {"rootIdentity": request["rootIdentity"], "entries": entries}
        if operation == "digest":
            path = confined(request["path"])
            if not parts(path):
                raise OSError(errno.EISDIR, "the workspace root is a directory", request["path"])
            fd = open_file(root, path, os.O_RDONLY)
            try:
                before = os.fstat(fd)
                digest = hashlib.sha256()
                total = 0
                chunks = []
                while True:
                    chunk = os.read(fd, CHUNK)
                    if not chunk: break
                    total += len(chunk)
                    if total > content_limit:
                        raise OSError(errno.EFBIG, "file exceeds the atomic read limit", request["path"])
                    digest.update(chunk)
                    if request.get("content"): chunks.append(chunk)
                unchanged(before, os.fstat(fd), request["path"])
                unchanged(before, entry_stat(root, path), request["path"])
                result = {"digest": digest.hexdigest(), "sizeBytes": total}
                if request.get("content"): result["base64"] = base64.b64encode(b"".join(chunks)).decode("ascii")
                return result
            finally: os.close(fd)
        if operation in ("readFile", "readFileString"):
            path = confined(request["path"])
            if not parts(path):
                raise OSError(errno.EISDIR, "the workspace root is a directory", request["path"])
            fd = open_file(root, path, os.O_RDONLY)
            try:
                chunks = []
                total = 0
                while True:
                    chunk = os.read(fd, CHUNK)
                    if not chunk: break
                    total += len(chunk)
                    # Charged per chunk, so a file larger than the contract is
                    # refused after one chunk of allocation rather than after
                    # the host has been asked to hold all of it.
                    if total > content_limit:
                        raise OSError(errno.EFBIG, "file exceeds the atomic read limit", request["path"])
                    chunks.append(chunk)
                data = b"".join(chunks)
            finally:
                os.close(fd)
            return {"base64": base64.b64encode(data).decode("ascii")}
        if operation == "exists":
            path = confined(request["path"])
            # The pinned root exists by construction: it is already open.
            if not parts(path):
                return True
            try:
                info = entry_stat(root, path)
            except FileNotFoundError:
                return False
            if stat.S_ISLNK(info.st_mode):
                raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", request["path"])
            # A directory, a FIFO, a device, and a socket all EXIST; only
            # reading or writing their content is refused.
            return True
        if operation == "readLink":
            path = confined(request["path"])
            if not parts(path):
                raise OSError(errno.EINVAL, "the workspace root is not a symbolic link", request["path"])
            directory, name = parent(root, path)
            try: return os.readlink(name, dir_fd=directory)
            finally: os.close(directory)
        if operation == "realPath":
            confined_path = confined(request["path"])
            if parts(confined_path):
                info = entry_stat(root, confined_path)
                if stat.S_ISLNK(info.st_mode):
                    raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", request["path"])
            return os.path.normpath(os.path.join(request["boundaryRoot"], confined_path.lstrip(os.sep)))
        if operation in ("writeFile", "writeFileString"):
            path = confined(request["path"])
            if not parts(path):
                raise OSError(errno.EISDIR, "the workspace root is a directory", request["path"])
            flag = options.get("flag", "w")
            if flag not in OPEN_FLAGS:
                raise BadArgument("unknown file open flag: " + str(flag))
            # Decoded and measured BEFORE the file is opened, so an over-limit
            # payload cannot truncate or partially overwrite the target.
            data = (base64.b64decode(request["data"], validate=True) if operation == "writeFile"
                    else request["data"].encode("utf-8"))
            if len(data) > content_limit:
                raise OSError(errno.EFBIG, "payload exceeds the atomic write limit", request["path"])
            # The open goes through open_file so the write path cannot drift from
            # the confinement contract the read path already enforces.
            fd = open_file(root, path, OPEN_FLAGS[flag], int(options.get("mode", 0o666)))
            try:
                # Truncation happens here rather than through O_TRUNC so that a
                # hard link, a FIFO, or a device is refused before the entry is
                # modified at all.
                if flag in TRUNCATED_FLAGS:
                    os.ftruncate(fd, 0)
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    # POSIX allows a zero-length write. Slicing by 0 would spin
                    # forever, so it is reported instead.
                    if written <= 0:
                        raise OSError(errno.EIO, "the host accepted no bytes", request["path"])
                    view = view[written:]
            finally:
                os.close(fd)
            return None
        if operation == "makeDirectory":
            path = confined(request["path"])
            recursive = bool(options.get("recursive"))
            mode = int(options.get("mode", 0o777))
            if not parts(path):
                # A recursive mkdir over an existing directory is a no-op, and
                # the pinned root is always an existing directory.
                if recursive: return None
                raise OSError(errno.EEXIST, "the workspace root already exists", request["path"])
            directory, name = parent(root, path, recursive, mode)
            try:
                try:
                    os.mkdir(name, mode, dir_fd=directory)
                except FileExistsError as conflict:
                    # The recursive option only excuses an existing DIRECTORY.
                    # The question is asked with an lstat relative to the
                    # pinned parent rather than by opening the entry, so a
                    # planted FIFO or device is answered without being opened:
                    # a symlink is not a directory even when it points at one,
                    # and a regular file keeps the EEXIST that Node reports.
                    if not recursive: raise
                    existing = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if not stat.S_ISDIR(existing.st_mode):
                        raise OSError(errno.ELOOP if stat.S_ISLNK(existing.st_mode) else errno.EEXIST,
                                      "existing entry is a " + file_type(existing.st_mode),
                                      request["path"])
            finally: os.close(directory)
            return None
        if operation == "readDirectory":
            return list_dir(root, confined(request["path"]), bool(options.get("recursive")), response_limit,
                            stable=pinned_root is not None)
        if operation == "remove":
            force = bool(options.get("force"))
            # Resolving the parent is INSIDE the force-aware handling, not
            # before it: parent() opens every intermediate component, so a
            # missing ancestor raised out here and force suppressed nothing.
            # Node's fs.rm(..., { force: true }) succeeds for a path whose
            # ancestors do not exist, and so does this.
            try:
                directory, name = parent(root, confined(request["path"]))
            except FileNotFoundError:
                if not force: raise
                return None
            try: remove_at(directory, name, bool(options.get("recursive")))
            except FileNotFoundError:
                if not force: raise
            finally: os.close(directory)
            return None
        if operation == "rename":
            old_dir, old_name = parent(root, confined(request["from"]))
            # Resolving the destination can fail on its own — a missing parent,
            # or the pinned root named as the destination — and the source
            # descriptor is already open by then, so it is closed explicitly
            # rather than left to interpreter teardown.
            try:
                new_dir, new_name = parent(root, confined(request["to"]))
            except BaseException:
                os.close(old_dir)
                raise
            try:
                info = os.stat(old_name, dir_fd=old_dir, follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode): raise OSError(errno.ELOOP, "symbolic link rename denied")
                try:
                    destination = os.stat(new_name, dir_fd=new_dir, follow_symlinks=False)
                    if stat.S_ISLNK(destination.st_mode): raise OSError(errno.ELOOP, "symbolic link rename denied")
                except FileNotFoundError:
                    pass
                os.rename(old_name, new_name, src_dir_fd=old_dir, dst_dir_fd=new_dir)
            finally:
                os.close(old_dir); os.close(new_dir)
            return None
        if operation == "stat":
            path = confined(request["path"])
            if not parts(path):
                info = os.fstat(root)
            else:
                info = entry_stat(root, path)
                if stat.S_ISLNK(info.st_mode):
                    raise OSError(errno.ELOOP, "symbolic links are outside the atomic boundary", request["path"])
                if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                    raise OSError(errno.EPERM, "hard-linked files cannot be confined", request["path"])
            birthtime = getattr(info, "st_birthtime", None)
            return {"type": file_type(info.st_mode),
                    "mtime": info.st_mtime * 1000, "atime": info.st_atime * 1000,
                    "birthtime": None if birthtime is None else birthtime * 1000,
                    # The RAW st_mode, file-type bits included, because that is
                    # what @effect/platform-node's stat returns and a caller
                    # testing "mode & S_IFMT" has to get the same answer from
                    # both. The "type" field above is the decoded convenience one.
                    "dev": info.st_dev, "ino": info.st_ino, "mode": info.st_mode,
                    "nlink": info.st_nlink, "uid": info.st_uid, "gid": info.st_gid,
                    "rdev": info.st_rdev, "size": str(info.st_size),
                    "blksize": (None if getattr(info, "st_blksize", None) is None
                                  else str(info.st_blksize)),
                    "blocks": getattr(info, "st_blocks", None)}
        if operation == "glob":
            root_path = request["root"]
            # Compiled before the tree is walked, so a pattern past the grammar
            # bounds costs no listing at all. Excludes are relativized exactly
            # as the selecting pattern is: an absolute exclude that stayed
            # absolute could never match a root-relative name, so the caller
            # received the paths it had forbidden.
            selected = GlobMatcher(relative_pattern(request["pattern"], root_path))
            excluded = [GlobMatcher(relative_pattern(item, root_path, True), False)
                        for item in options.get("exclude", [])]
            # The root is the only directory the walk never emits. Deciding it
            # after listing leaks every child and charges work for a tree the
            # caller forbade, so the same pruning question must stop the walk.
            if any(pattern.matches([], True) for pattern in excluded):
                return []
            def prunes(name, is_dir):
                segments = name.split("/")
                return any(pattern.matches(segments, is_dir) for pattern in excluded)
            entries = list_dir(root, confined(root_path), True, response_limit, True, prunes,
                               stable=pinned_root is not None)
            matches = []
            total = 32
            # The pinned root is a candidate in its own right: "**" and "**/"
            # both name it, exactly as the native globber returns "." for it.
            for name, is_dir in [("", True)] + entries:
                segments = name.split("/") if name else []
                if not selected.matches(segments, is_dir):
                    continue
                match = os.path.join(root_path, name) if name else root_path
                total += len(json.dumps(match, ensure_ascii=False).encode("utf-8")) + 1
                if total > response_limit:
                    raise OSError(errno.EFBIG, "glob result exceeds the response limit", root_path)
                matches.append(match)
            return matches
        raise OSError(errno.ENOTSUP, "atomic operation is unsupported", operation)
    finally:
        os.close(root)

def read_header(stream):
    # One byte at a time against a cap, so an unframed stream cannot make the
    # helper buffer without bound before it has agreed on a length.
    header = b""
    while not header.endswith(b"\n"):
        if len(header) >= HEADER_CAP:
            raise OSError(EPROTO, "atomic request header is unframed")
        byte = stream.read(1)
        if not byte:
            raise OSError(EPROTO, "atomic request header is truncated")
        header += byte
    return header[:-1].decode("ascii")

def read_exact(stream, count):
    chunks = []
    remaining = count
    while remaining > 0:
        chunk = stream.read(min(remaining, CHUNK))
        if not chunk:
            raise OSError(EPROTO, "atomic request is truncated")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)

def respond(payload, limit):
    # Length-framed over the byte stream rather than through print(). The text
    # wrappers on sys.stdin and sys.stdout encode with whatever the ambient
    # locale says, so a host started under a legacy locale silently
    # mistranslated every non-ASCII path and every writeFileString payload --
    # addressing a different file, or writing mojibake, and reporting success
    # either way. Both directions are pinned to UTF-8 here, and -X utf8 on the
    # command line pins the filesystem encoding the same way. The frame is what
    # lets the host tell a complete response from a truncated one, from two.
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(body) > limit:
        body = json.dumps({"ok": False, "code": None, "badArgument": False,
                           "message": "atomic response exceeds the %d byte limit" % limit},
                          separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(("%s %d\n" % (PROTOCOL, len(body))).encode("ascii"))
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()

response_limit = 1 << 16
try:
    fields = read_header(sys.stdin.buffer).split(" ")
    if len(fields) != 5 or fields[0] != PROTOCOL:
        raise OSError(EPROTO, "atomic request is not framed")
    declared, request_limit, content_limit, declared_response = (int(field) for field in fields[1:])
    if not 0 < declared_response <= HARD_CAP or not 0 < request_limit <= HARD_CAP or not 0 < content_limit <= HARD_CAP:
        raise OSError(EPROTO, "atomic limits are out of range")
    response_limit = declared_response
    if not 0 <= declared <= request_limit:
        raise OSError(errno.EFBIG, "atomic request exceeds the request limit")
    payload = read_exact(sys.stdin.buffer, declared)
    if sys.stdin.buffer.read(1):
        raise OSError(EPROTO, "atomic request carried trailing bytes")
    respond({"ok": True, "value": main(json.loads(payload.decode("utf-8")), content_limit, response_limit)},
            response_limit)
except BaseException as error:
    number = getattr(error, "errno", None)
    respond({"ok": False,
             "code": errno.errorcode.get(number) if isinstance(number, int) else None,
             "syscall": SYSCALL[0],
             "badArgument": isinstance(error, BadArgument),
             "message": str(error)[:MESSAGE_CAP]}, response_limit)
`

/**
 * The POSIX helper program the adapter runs. Exported so the protocol guards
 * on the helper's own side can be driven with frames the adapter would never
 * send, which is the only way to observe them.
 *
 * @since 0.1.0
 * @category constants
 */
export const program: string = helper

/**
 * The absolute path the adapter runs the POSIX helper from. It is a fixed
 * absolute path and never a `PATH` lookup: `-I` isolates the interpreter only
 * *after* one has been chosen, so a `python3` planted in the working directory
 * or on an injected `PATH` would already have executed arbitrary code inside
 * the process that holds the pinned root descriptor.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultExecutable = "/usr/bin/python3"

/**
 * Byte ceilings for the helper protocol. Every one of them is a contract, not
 * a tuning knob: without them a large file, a large directory tree, or a
 * malfunctioning helper makes the host allocate until it dies.
 *
 * - `content` bounds the bytes a single `readFile`/`writeFile` may carry.
 * - `request` bounds the framed request; an over-limit request is refused
 *   before an interpreter is even started.
 * - `response` bounds the framed response, and is what a directory listing is
 *   charged against as it is built. It bounds the REJECTION envelope too, so a
 *   ceiling small enough to cut one off degrades that operation's typed reason
 *   to the fail-closed one.
 * - `stderr` bounds the diagnostic text retained from a failing helper.
 * - `batchEntry` bounds one batch member's encoded success or failure envelope.
 * - `batchSize` bounds the number of operations in one batch, at most 128.
 *
 * All except `batchSize` count bytes. The two ceilings that decide whether the host
 * survives a wide fan-out are {@link Options.concurrency}, which bounds how
 * many interpreters run at once, and {@link Options.timeoutMs}, which bounds
 * how long any one of them may take.
 *
 * @since 0.1.0
 * @category models
 */
export interface Limits {
  readonly content: number
  readonly request: number
  readonly response: number
  readonly stderr: number
  /** Maximum operations in one helper invocation, at most 128. */
  readonly batchSize: number
  /** Maximum encoded result bytes for one batch member. */
  readonly batchEntry: number
}

/**
 * 16 MiB of file content, 24 MiB of framed request and response (base64
 * expands 16 MiB to 22369624 bytes, which has to fit), and 64 KiB of retained
 * helper diagnostics.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultLimits: Limits = {
  content: 16 * 1024 * 1024,
  request: 24 * 1024 * 1024,
  response: 24 * 1024 * 1024,
  stderr: 64 * 1024,
  batchSize: KernelFileSystem.maxBatchSize,
  batchEntry: 24 * 1024 * 1024
}

/**
 * The default number of helper processes that may run at once:
 * `os.availableParallelism()`.
 *
 * @since 1.0.0-rc.0
 * @category constants
 */
export const defaultConcurrency: number = availableParallelism()

/**
 * How long one helper may run before it is killed and the operation fails
 * closed: five minutes.
 *
 * It is a backstop, not a latency budget. A read at the content ceiling over a
 * slow disk has to fit under it, so it is generous; what it bounds is a helper
 * that will never answer at all.
 *
 * @since 1.0.0-rc.0
 * @category constants
 */
export const defaultTimeoutMs = 300_000

/**
 * The deliberate seam for a POSIX host that installs CPython somewhere other
 * than {@link defaultExecutable}, or that needs different ceilings. It is
 * configuration, never discovery: the executable is validated as an absolute,
 * executable regular file outside the confined workspace on every request, and
 * every other field is read ONCE, when the layer is built.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly executable?: string | undefined
  readonly limits?: Partial<Limits> | undefined
  /**
   * How many helper processes may run at once. Default
   * {@link defaultConcurrency}.
   *
   * Each ordinary operation or batch starts one helper, so an unbounded
   * `Effect.forEach` over a directory would start
   * one interpreter per entry. This ceiling is what keeps a wide fan-out from
   * pinning every core; it is a contract, not a tuning knob.
   */
  readonly concurrency?: number | undefined
  /**
   * How long one helper may run before it is killed and the operation fails
   * closed, in milliseconds. Default {@link defaultTimeoutMs}.
   */
  readonly timeoutMs?: number | undefined
}

/**
 * Everything read out of {@link Options} once, when the layer is built.
 *
 * Snapshotted rather than re-read per request: `Options` is a plain object the
 * caller still holds, and a byte ceiling that changes under a running host is
 * not a ceiling. The executable is deliberately NOT here — it is re-validated
 * per request, because the file it names can be replaced while the host runs.
 */
interface Settings {
  readonly limits: Limits
  readonly timeoutMs: number
  readonly semaphore: Semaphore.Semaphore
}

interface HelperResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly code?: string | null
  readonly syscall?: string | null
  readonly badArgument?: boolean
  readonly message?: string
}

const moduleName = "AtomicFileSystem"
let startedHelpers = 0

/**
 * Process-local helper starts, for cost counters and local measurements.
 * Includes helpers later cancelled or refused; rejected preflight starts none.
 *
 * @since 1.0.0
 * @category metrics
 */
export const helperSpawns = (): number => startedHelpers

const protocol = "flows-atomic/1"
/** Room for `flows-atomic/1 <digits>\n` above the payload ceiling. */
const frameHeaderBytes = 64
/** The helper enforces the same ceiling before it trusts a declared limit. */
const hardLimitBytes = 256 * 1024 * 1024
/** `setTimeout` clamps a longer delay to 1 ms, so a bigger backstop is none. */
const maxTimeoutMs = 2_147_483_647
/** An inert working directory: nothing the helper could import lives there. */
const inertDirectory = "/"
const decimal = /^[0-9]+$/
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * The errno-to-reason table `@effect/platform-node` applies to a Node
 * `ErrnoException`, so a caller reads the same typed reason it would get from
 * the native filesystem. `EPERM` and `ENOTSUP` are added because they are how
 * this helper reports its own refusals — outside the pinned root, a hard link,
 * a symlink, a special file, the root itself, or a host without
 * descriptor-relative POSIX. `EFBIG` and `ENXIO` are how it reports a payload
 * over the documented limit and a write-only open of a reader-less FIFO.
 * `EPROTO` is a framing failure and stays fail-closed. `EOPNOTSUPP` is the
 * same number as `ENOTSUP` on Linux, where which of the two names Python
 * reports for it is an implementation detail.
 */
const reasons: Record<string, PlatformError.SystemErrorTag | undefined> = {
  EACCES: "PermissionDenied",
  EBUSY: "Busy",
  EEXIST: "AlreadyExists",
  EFBIG: "BadResource",
  EISDIR: "BadResource",
  ELOOP: "BadResource",
  ENOENT: "NotFound",
  ENOTDIR: "BadResource",
  ENOTSUP: "PermissionDenied",
  ENXIO: "BadResource",
  EOPNOTSUPP: "PermissionDenied",
  EPERM: "PermissionDenied",
  EPROTO: "PermissionDenied"
}

/**
 * A rejection carrying no errno is a transport or host failure — an absent
 * interpreter, a killed child, output that is not a helper result — and stays
 * `PermissionDenied` so the boundary fails closed rather than reporting a
 * benign-looking reason for an operation that never ran.
 */
const failure = (
  request: KernelFileSystem.AtomicRequest,
  cause: unknown,
  rejection?: HelperResult
): PlatformError.PlatformError => {
  const method = request.operation
  if (rejection?.badArgument === true) {
    return PlatformError.badArgument({ module: moduleName, method, description: rejection.message, cause })
  }
  const code = rejection?.code ?? undefined
  return PlatformError.systemError({
    module: moduleName,
    method,
    pathOrDescriptor: request.path ?? request.from ?? request.pattern,
    // `@effect/platform-node` sets `syscall` on every system error it reports,
    // so a consumer that switches on it has to read a populated field here too.
    // It names the operation's own syscall rather than whichever of the calls
    // that operation makes actually raised, so it says what was attempted, not
    // which step failed. A transport failure names no syscall at all, because
    // no syscall ran.
    syscall: rejection?.syscall ?? undefined,
    _tag: code === undefined ? "PermissionDenied" : reasons[code] ?? "Unknown",
    // The cause is repeated into the description because a fail-closed refusal
    // that says only "failed closed" is unactionable: an absent interpreter, a
    // response over the limit, and a mangled frame all look alike otherwise.
    description: code === undefined
      ? `descriptor-relative filesystem isolation failed closed: ${String(cause)}`
      : rejection?.message,
    cause
  })
}

/**
 * True when `target` is at or below `root`. Both are absolute and already
 * canonical, and this module is POSIX-only, so `path.relative` answers with a
 * leading `..` for everything outside and never with an absolute path.
 */
const inside = (root: string, target: string): boolean => {
  const path = relative(root, target)
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
}

/** Resolve symlinks without replacing a hard-linked executable's entry name. */
const executablePath = (configured: string): string => {
  let current = configured
  for (let links = 0; links < 40; links++) {
    if (current.endsWith("/")) throw new Error("atomic helper executable cannot end with a directory separator")
    // Bun's macOS realpath can return another hard link to the final inode:
    // /usr/bin/python3 became /usr/bin/git during concurrent guarded reads.
    // Directories cannot have those file aliases. Resolve the parent, preserve
    // the leaf name, and explicitly follow only actual leaf symlinks.
    const parent = realpathSync.native(dirname(current))
    const candidate = join(parent, basename(current))
    if (!lstatSync(candidate).isSymbolicLink()) return candidate
    const target = readlinkSync(candidate)
    // Do not normalize `link/..` lexically; realpath must traverse it first.
    current = isAbsolute(target) ? target : `${parent}/${target}`
  }
  throw new Error("atomic helper executable has too many symbolic links")
}

/**
 * Resolves the configured interpreter to an absolute, executable regular file
 * that the confined workspace cannot have supplied. Every failure throws, and
 * every throw becomes a fail-closed `PermissionDenied`, so a host without a
 * usable interpreter performs no filesystem operation at all.
 */
const usableExecutable = (configured: string, boundaryRoot: string | undefined): string => {
  if (!isAbsolute(configured)) {
    throw new Error(`atomic helper executable must be an absolute path, got ${JSON.stringify(configured)}`)
  }
  // Resolved first: the checks below have to describe the file that will
  // actually run, not the name that leads to it.
  const resolved = executablePath(configured)
  if (!statSync(resolved).isFile()) {
    throw new Error(`atomic helper executable is not a regular file: ${resolved}`)
  }
  accessSync(resolved, constants.X_OK)
  if (boundaryRoot !== undefined && inside(boundaryRoot, resolved)) {
    throw new Error(`atomic helper executable must live outside the confined workspace: ${resolved}`)
  }
  return resolved
}

/** Resolves every optional byte ceiling and refuses values that could disable a bound. */
const resolveLimits = (overrides: Partial<Limits> | undefined): Limits => {
  const limits: Limits = {
    content: overrides?.content ?? defaultLimits.content,
    request: overrides?.request ?? defaultLimits.request,
    response: overrides?.response ?? defaultLimits.response,
    stderr: overrides?.stderr ?? defaultLimits.stderr,
    batchSize: overrides?.batchSize ?? defaultLimits.batchSize,
    batchEntry: overrides?.batchEntry ?? defaultLimits.batchEntry
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimitBytes) {
      throw new Error(
        `atomic helper ${name} limit must be a positive integer no greater than ${hardLimitBytes}`
      )
    }
  }
  if (limits.batchSize > KernelFileSystem.maxBatchSize) {
    throw new Error(`atomic helper batchSize limit must be no greater than ${KernelFileSystem.maxBatchSize}`)
  }
  return limits
}

/**
 * Reads the whole of {@link Options} once, at layer construction.
 *
 * A rejected value is carried rather than thrown, because the failure a caller
 * sees for it is a typed `BadArgument` on the first operation and not an
 * exception escaping a layer.
 */
const resolveSettings = (options: Options): Settings | { readonly invalid: unknown } => {
  try {
    const limits = resolveLimits(options.limits)
    const concurrency = options.concurrency ?? defaultConcurrency
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new Error("atomic helper concurrency must be a positive integer")
    }
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > maxTimeoutMs) {
      throw new Error("atomic helper timeoutMs must be a positive integer no greater than 2147483647")
    }
    return { limits, timeoutMs, semaphore: Semaphore.makeUnsafe(concurrency) }
  } catch (invalid) {
    return { invalid }
  }
}

const decode = (frame: Buffer, limits: Limits): HelperResult => {
  const newline = frame.indexOf(10)
  if (newline < 0 || newline >= frameHeaderBytes) {
    throw new Error("atomic helper response is not framed")
  }
  const fields = frame.subarray(0, newline).toString("ascii").split(" ")
  if (fields.length !== 2 || fields[0] !== protocol) {
    throw new Error("atomic helper response carries an unknown protocol tag")
  }
  const declared = fields[1]!
  if (!decimal.test(declared)) {
    throw new Error(`atomic helper declared a non-decimal response length: ${declared}`)
  }
  const length = Number(declared)
  if (!Number.isSafeInteger(length) || length < 0 || length > limits.response) {
    throw new Error(`atomic helper declared an out-of-range response length: ${declared}`)
  }
  const body = frame.subarray(newline + 1)
  if (body.byteLength !== length) {
    // Fewer bytes is a truncated response (a killed helper); more is a second
    // frame appended to the first. Either way the stream is not one answer.
    throw new Error(`atomic helper declared ${length} response bytes and wrote ${body.byteLength}`)
  }
  // Decoded from the complete frame, so a multi-byte character split across
  // two stdout chunks is never mangled on the way in.
  return resultEnvelope(JSON.parse(fatalUtf8.decode(body)))
}

const resultEnvelope = (input: unknown): HelperResult => {
  const value = input as HelperResult
  if (value === null || typeof value !== "object" || typeof value.ok !== "boolean") {
    throw new Error("atomic helper response is not a result envelope")
  }
  if (value.code !== undefined && value.code !== null && typeof value.code !== "string") {
    throw new Error("atomic helper response carries a non-string error code")
  }
  if (value.syscall !== undefined && value.syscall !== null && typeof value.syscall !== "string") {
    throw new Error("atomic helper response carries a non-string syscall")
  }
  if (value.badArgument !== undefined && typeof value.badArgument !== "boolean") {
    throw new Error("atomic helper response carries a non-boolean badArgument flag")
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    throw new Error("atomic helper response carries a non-string message")
  }
  return value
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object") {
    throw new Error(`atomic helper returned a non-object ${what}`)
  }
  return value as Record<string, unknown>
}

const finite = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`atomic helper returned a non-numeric ${field}`)
  }
  return value
}

const integer = (value: unknown, field: string): number => {
  const numeric = finite(value, field)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`atomic helper returned an out-of-range ${field}: ${numeric}`)
  }
  return numeric
}

const date = (value: unknown, field: string): Date => {
  const result = new Date(finite(value, field))
  if (!Number.isFinite(result.getTime())) {
    throw new Error(`atomic helper returned an out-of-range ${field}`)
  }
  return result
}

const size = (value: unknown, field: string): FileSystem.Size => {
  if (typeof value === "string" && decimal.test(value)) {
    return FileSystem.Size(BigInt(value))
  }
  return FileSystem.Size(BigInt(integer(value, field)))
}

const optional = <A>(value: unknown, read: (value: unknown) => A): Option.Option<A> =>
  value === null || value === undefined ? Option.none() : Option.some(read(value))

/** Effect's own `FileSystem.File.Type`; anything else is a helper defect. */
const fileTypes = new Set<string>([
  "File",
  "Directory",
  "SymbolicLink",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
  "Unknown"
])

const toInfo = (value: unknown): FileSystem.File.Info => {
  const info = record(value, "stat")
  if (!fileTypes.has(info.type as string)) {
    throw new Error(`atomic helper returned an unknown file type: ${String(info.type)}`)
  }
  return {
    type: info.type as FileSystem.File.Type,
    mtime: Option.some(date(info.mtime, "mtime")),
    atime: Option.some(date(info.atime, "atime")),
    birthtime: optional(info.birthtime, (raw) => date(raw, "birthtime")),
    dev: integer(info.dev, "dev"),
    ino: Option.some(integer(info.ino, "ino")),
    mode: integer(info.mode, "mode"),
    nlink: Option.some(integer(info.nlink, "nlink")),
    uid: Option.some(integer(info.uid, "uid")),
    gid: Option.some(integer(info.gid, "gid")),
    rdev: Option.some(integer(info.rdev, "rdev")),
    size: size(info.size, "size"),
    blksize: optional(info.blksize, (raw) => size(raw, "blksize")),
    blocks: optional(info.blocks, (raw) => integer(raw, "blocks"))
  }
}

const isBase64 = (encoded: string): boolean => {
  if (encoded.length % 4 !== 0) return false
  let end = encoded.length
  if (encoded.endsWith("=")) {
    end--
    if (encoded[end - 1] === "=") end--
  }
  // A repeated-group regexp exhausts V8's stack on ordinary multi-MiB reads.
  // Scan the alphabet once, excluding at most two trailing padding characters.
  for (let index = 0; index < end; index++) {
    const code = encoded.charCodeAt(index)
    if (
      !(code >= 65 && code <= 90) && !(code >= 97 && code <= 122) &&
      !(code >= 48 && code <= 57) && code !== 43 && code !== 47
    ) return false
  }
  return true
}

const toBytes = (value: unknown, limit: number): Uint8Array => {
  const payload = record(value, "read result")
  const encoded = payload.base64
  // Buffer.from silently drops characters it does not recognise, so the shape
  // is checked before the decode rather than inferred from its output.
  if (typeof encoded !== "string" || !isBase64(encoded)) {
    throw new Error("atomic helper returned a malformed base64 payload")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength > limit) {
    throw new Error(`atomic helper returned ${bytes.byteLength} bytes, over the ${limit} byte read limit`)
  }
  return Uint8Array.from(bytes)
}

const toStringResult = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`atomic helper returned an invalid ${what}`)
  }
  return value
}

const maxListingEntries = 100_000

const toStringArray = (value: unknown, what: string): Array<string> => {
  if (!Array.isArray(value) || value.length > maxListingEntries) {
    throw new Error(`atomic helper returned an invalid ${what}`)
  }
  const result = value.map((entry) => toStringResult(entry, `${what} entry`))
  if (new Set(result).size !== result.length) {
    throw new Error(`atomic helper returned duplicate ${what} entries`)
  }
  return result
}

const convert = <A>(
  request: KernelFileSystem.AtomicRequest,
  value: unknown,
  limits: Limits
): Effect.Effect<A, PlatformError.PlatformError> => {
  if (request.operation === "batch") {
    const response = record(value, "batch")
    const requests = request.requests!
    if (
      response.rootIdentity !== request.rootIdentity || !Array.isArray(response.entries) ||
      response.entries.length !== requests.length
    ) {
      throw new Error("atomic helper returned a foreign or incomplete batch")
    }
    const seen = new Set<number>()
    let previous = ""
    let previousIndex = -1
    const pending = response.entries.map((raw) => {
      const entry = record(raw, "batch entry")
      const index = integer(entry.index, "batch index")
      const member = requests[index]
      if (
        member === undefined || seen.has(index) || entry.path !== member.path ||
        member.path < previous || (member.path === previous && index <= previousIndex)
      ) {
        throw new Error("atomic helper returned an invalid batch member identity or order")
      }
      seen.add(index)
      previous = member.path
      previousIndex = index
      if (Buffer.byteLength(JSON.stringify(entry.result), "utf8") > limits.batchEntry) {
        throw new Error("atomic helper returned an oversized batch entry")
      }
      const envelope = resultEnvelope(entry.result)
      const identity = { index, path: member.path }
      if (!envelope.ok) {
        return Effect.succeed({
          ...identity,
          result: Result.fail(failure(member, new Error(envelope.message ?? "atomic batch member failed"), envelope))
        })
      }
      if (member.operation === "digest") {
        const measured = record(envelope.value, "digest")
        if (typeof measured.digest !== "string" || !/^[a-f0-9]{64}$/.test(measured.digest)) {
          throw new Error("atomic helper returned an invalid SHA-256 digest")
        }
        const sizeBytes = integer(measured.sizeBytes, "digest size")
        if (sizeBytes > limits.content) throw new Error("atomic helper returned an oversized digest measurement")
        const bytes = member.content === true ? toBytes(measured, limits.content) : undefined
        if (bytes !== undefined && bytes.length !== sizeBytes) {
          throw new Error("atomic helper returned a mismatched digest size")
        }
        return Effect.succeed({
          ...identity,
          result: Result.succeed<KernelFileSystem.BatchValue>({
            operation: "digest",
            digest: measured.digest,
            sizeBytes,
            ...(bytes === undefined ? {} : { bytes })
          })
        })
      }
      return Effect.map(convert(member, envelope.value, limits), (converted) => ({
        ...identity,
        result: Result.succeed<KernelFileSystem.BatchValue>(
          member.operation === "stat"
            ? { operation: "stat", info: converted as FileSystem.File.Info }
            : { operation: member.operation, paths: (converted as Array<string>).sort() }
        )
      }))
    })
    return Effect.map(Effect.all(pending), (entries) => ({ rootIdentity: response.rootIdentity, entries }) as A)
  }
  if (request.operation === "readFile" || request.operation === "readFileString") {
    // An empty file encodes to an empty string, so the payload is read by
    // shape: truthiness would return the raw envelope for it instead.
    const bytes = toBytes(value, limits.content)
    if (request.operation === "readFile") {
      return Effect.succeed(bytes as A)
    }
    try {
      return Effect.succeed(new TextDecoder(request.encoding).decode(bytes) as A)
    } catch (cause) {
      // Effect's own `readFileString` reports a rejected encoding as a
      // BadArgument, not as a filesystem failure.
      return Effect.fail(PlatformError.badArgument({
        module: "FileSystem",
        method: "readFileString",
        description: "invalid encoding",
        cause
      }))
    }
  }
  if (request.operation === "stat") {
    return Effect.succeed(toInfo(value) as A)
  }
  if (request.operation === "exists") {
    if (typeof value !== "boolean") {
      throw new Error("atomic helper returned a non-boolean exists result")
    }
    return Effect.succeed(value as A)
  }
  if (request.operation === "readLink" || request.operation === "realPath") {
    return Effect.succeed(toStringResult(value, `${request.operation} result`) as A)
  }
  if (request.operation === "readDirectory" || request.operation === "glob") {
    return Effect.succeed(toStringArray(value, `${request.operation} result`) as A)
  }
  if (
    request.operation === "writeFile" ||
    request.operation === "writeFileString" ||
    request.operation === "makeDirectory" ||
    request.operation === "remove" ||
    request.operation === "rename"
  ) {
    if (value !== null) {
      throw new Error(`atomic helper returned a non-null ${request.operation} result`)
    }
    return Effect.succeed(undefined as A)
  }
  throw new Error(`atomic helper returned success for unsupported operation ${request.operation}`)
}

const spawnHelper = <A>(
  request: KernelFileSystem.AtomicRequest,
  executable: string,
  payload: Buffer,
  settings: Settings
): Effect.Effect<A, PlatformError.PlatformError> =>
  Effect.callback<A, PlatformError.PlatformError>((resume) => {
    const limits = settings.limits
    let settled = false
    const stdout: Array<Buffer> = []
    let stdoutBytes = 0
    const stderr: Array<Buffer> = []
    let stderrBytes = 0
    let truncated = false
    let writeFailure: unknown

    // `-I` (isolated) and `-X utf8` are part of the boundary, not tuning.
    //
    // Without `-I`, `python3 -c` prepends the CURRENT WORKING DIRECTORY to
    // `sys.path`. A `base64.py` (or `re.py`, `stat.py`) reachable from there
    // is imported and executed by the helper — arbitrary code inside the
    // process that holds the pinned root descriptor. `-I` also implies `-E`,
    // so `PYTHONPATH` and `PYTHONSTARTUP` cannot reintroduce the same hijack
    // from the environment, and `-s`, so a user site directory cannot either.
    // The cost is that `PYTHONHOME` is ignored too: an interpreter that needs
    // it fails closed like any other unusable helper.
    //
    // `-X utf8` is a command-line option rather than `PYTHONUTF8`, because
    // `-E` would discard the environment variable. It pins stdio and the
    // filesystem encoding to UTF-8 so the request bytes, the path bytes the
    // syscalls receive, and the response all agree regardless of the locale.
    //
    // The inert cwd and the empty environment make those guarantees
    // structural rather than flag-deep: there is no ambient directory to
    // search and no variable to read, whichever interpreter is configured.
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, ["-I", "-X", "utf8", "-c", helper], {
        cwd: inertDirectory,
        env: {},
        stdio: ["pipe", "pipe", "pipe"]
      })
      startedHelpers++
    } catch (cause) {
      // libuv reports some exec failures — `ENOEXEC` for a file that is
      // neither a script nor a binary — by throwing rather than by emitting an
      // `error` event, so both arrivals have to end in the same refusal.
      resume(Effect.fail(failure(request, cause)))
      return Effect.void
    }
    // `deadline` is armed below, after the completion it resumes through
    // exists. Reading it here is safe because nothing calls `cleanup` before
    // then: the one earlier exit, a spawn that threw, resumes and returns.
    const cleanup = () => {
      clearTimeout(deadline)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill("SIGKILL")
    }
    const complete = (effect: Effect.Effect<A, PlatformError.PlatformError>) => {
      if (settled) return
      settled = true
      // Every exit path drains and kills, so an overflowing, hung, or already
      // finished helper leaves no descriptor and no child behind.
      cleanup()
      resume(effect)
    }
    // A wall-clock backstop, independent of every byte ceiling. Those bound
    // what a helper may SAY; nothing bounds how long it may take to say it, and
    // a helper that never answers would otherwise hold the fiber until the run
    // itself is interrupted.
    const deadline = setTimeout(() => {
      complete(Effect.fail(failure(
        request,
        new Error(`atomic helper did not answer within ${settings.timeoutMs} ms`)
      )))
    }, settings.timeoutMs)
    deadline.unref()
    // Raw buffers, never decoded strings: a chunk boundary in the middle of a
    // multi-byte character would otherwise be decoded as two replacement
    // characters before the JSON parse ever saw it. Concatenating once at the
    // end also keeps accumulation linear instead of quadratic.
    // Retained bytes are bounded by the ceiling plus at most one pipe chunk:
    // an overflowing chunk is sliced before it is retained, so the host never
    // relies on the stream implementation's chunk-size convention.
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = limits.response + frameHeaderBytes - stdoutBytes
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          stdout.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
        }
        complete(Effect.fail(failure(
          request,
          new Error(`atomic helper wrote more than ${limits.response} response bytes`)
        )))
        return
      }
      stdoutBytes += chunk.byteLength
      stdout.push(chunk)
    })
    // stderr is bounded on its own budget: a helper that says nothing useful
    // on stdout must not be able to exhaust the host through diagnostics.
    // Destroying the pipe stops the helper at its next write rather than
    // letting it produce output nobody will read.
    child.stderr.on("data", (chunk: Buffer) => {
      // Sliced to the remaining room rather than kept whole, so the retained
      // text is exactly the budget and not the budget plus a pipe buffer.
      const slice = chunk.subarray(0, limits.stderr - stderrBytes)
      stderrBytes += slice.byteLength
      stderr.push(slice)
      if (stderrBytes >= limits.stderr) {
        truncated = true
        child.stderr.destroy()
      }
    })
    child.on("error", (cause) => complete(Effect.fail(failure(request, cause))))
    // A helper that exits before draining stdin — an unavailable interpreter,
    // a rejected request, an interrupt that killed it mid-write — makes the
    // request write fail with EPIPE. Without a listener that is an unhandled
    // `error` event on the pipe, which terminates the host process instead of
    // failing one filesystem call. It is recorded rather than resumed on, so
    // that a helper which did manage to report a real errno keeps precedence
    // over the broken pipe its own exit caused.
    child.stdin.on("error", (cause) => {
      writeFailure = cause
    })
    child.on("close", (code) => {
      let envelope: HelperResult | undefined
      let malformed: unknown
      try {
        envelope = decode(Buffer.concat(stdout), limits)
      } catch (cause) {
        malformed = cause
      }
      if (envelope !== undefined && !envelope.ok) {
        // The helper's own typed rejection outranks the exit status and any
        // transport noise: it is the only thing that knows which errno the
        // syscall produced.
        complete(Effect.fail(failure(
          request,
          new Error(envelope.message ?? "atomic helper rejected the operation"),
          envelope
        )))
        return
      }
      if (envelope !== undefined && code === 0) {
        try {
          complete(convert<A>(request, envelope.value, limits))
        } catch (cause) {
          complete(Effect.fail(failure(request, cause)))
        }
        return
      }
      const text = Buffer.concat(stderr).toString("utf8")
      complete(Effect.fail(failure(
        request,
        text !== ""
          ? new Error(`atomic helper exited ${code}: ${text}${truncated ? " (truncated)" : ""}`)
          : writeFailure !== undefined
          ? writeFailure
          : malformed !== undefined
          ? malformed
          : new Error(`atomic helper exited ${code}`)
      )))
    })
    child.stdin.end(payload)
    return Effect.sync(cleanup)
  })

const execute = (options: Options, resolved: Settings | { readonly invalid: unknown }) =>
<A>(
  request: KernelFileSystem.AtomicRequest
): Effect.Effect<A, PlatformError.PlatformError> =>
  Effect.suspend(() => {
    if ("invalid" in resolved) {
      const cause = resolved.invalid
      return Effect.fail(PlatformError.badArgument({
        module: moduleName,
        method: request.operation,
        description: cause instanceof Error ? cause.message : "atomic helper limits are invalid",
        cause
      }))
    }
    const limits = resolved.limits
    if (
      request.operation === "batch" &&
      (!Array.isArray(request.requests) || request.requests.length === 0 || request.requests.length > limits.batchSize)
    ) {
      return Effect.fail(PlatformError.badArgument({
        module: moduleName,
        method: "batch",
        description: `atomic batch must contain 1 to ${limits.batchSize} operations`
      }))
    }
    // Admission bounds request serialization and framing as well as children.
    // Queued callers retain their input, without another full payload copy.
    return resolved.semaphore.withPermits(1)(Effect.suspend(() => {
      let body: Buffer
      try {
        const serialized = JSON.stringify(
          request.operation === "batch"
            ? { ...request, batchSize: limits.batchSize, batchEntry: limits.batchEntry }
            : request
        )
        if (serialized === undefined) {
          throw new Error("atomic request is not serializable")
        }
        body = Buffer.from(serialized, "utf8")
      } catch (cause) {
        return Effect.fail(PlatformError.badArgument({
          module: moduleName,
          method: request.operation,
          description: "atomic request is not serializable",
          cause
        }))
      }
      if (body.byteLength > limits.request) {
        // Refused before an interpreter exists: an over-limit request is caller
        // input, and nothing about it improves by being sent.
        return Effect.fail(PlatformError.badArgument({
          module: moduleName,
          method: request.operation,
          description: `atomic request of ${body.byteLength} bytes exceeds the ${limits.request} byte limit`
        }))
      }
      const header = Buffer.from(
        `${protocol} ${body.byteLength} ${limits.request} ${limits.content} ${limits.response}\n`,
        "ascii"
      )
      let executable: string
      try {
        executable = usableExecutable(options.executable ?? defaultExecutable, request.boundaryRoot)
      } catch (cause) {
        return Effect.fail(failure(request, cause))
      }
      return spawnHelper<A>(
        request,
        executable,
        Buffer.concat([header, body], header.byteLength + body.byteLength),
        resolved
      )
    }))
  })

/**
 * A Node filesystem layer carrying the kernel's atomic host extension, built
 * against an explicitly configured interpreter, byte limits, process ceiling,
 * and helper timeout.
 *
 * Every field of {@link Options} except `executable` is read once, here. The
 * concurrency ceiling is one semaphore for the whole layer rather than one per
 * request, which is the only arrangement that bounds anything.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerWith = (options: Options): Layer.Layer<FileSystem.FileSystem> => {
  // Outside the layer body on purpose. Inside it the settings would be read
  // again on every BUILD, so two compositions of the same layer value could
  // enforce two different ceilings out of one mutated object, and each would
  // get a process ceiling of its own instead of sharing one.
  const settings = resolveSettings(options)
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.map(
      FileSystem.FileSystem,
      (fileSystem) =>
        KernelFileSystem.withAtomicFileSystem(fileSystem, {
          execute: execute(options, settings),
          batchLimits: {
            size: "invalid" in settings ? defaultLimits.batchSize : settings.limits.batchSize,
            response: "invalid" in settings ? defaultLimits.response : settings.limits.response
          },
          contentLimit: "invalid" in settings ? defaultLimits.content : settings.limits.content
        })
    )
  ).pipe(Layer.provide(NodeFileSystem.layer))
}

/** A Node filesystem layer carrying the kernel's atomic host extension.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<FileSystem.FileSystem> = layerWith({})
