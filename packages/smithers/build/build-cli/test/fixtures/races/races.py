"""Programs whose threads, and in some cases a second process, change the same names at once.

Each logs the answer every one of its own calls got (`LOG [[kind, path, errno], ...]`), so a recorder's lines can be
held against the kernel's answers (test/helpers/Races.ts).

    python3 -I -B races.py setup <case> <workspace>   the commit's tree
    python3 -I -B races.py run <case>                 the step, run in the workspace
    python3 -I -B races.py change <case> <workspace>  a commit that changes what every run of the step read;
                                                      prints the path it changed

`run` prints one JSON line of facts the run itself knows (what it read, which call won).
RACE_ROUNDS sets how many times each thread races (default 200).
"""
import json
import os
import random
import socket
import sys
import threading
import time

ROUNDS = int(os.environ.get("RACE_ROUNDS", "200"))


def write(path, text):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


LOG = []
KINDS = {}


def quiet(call, *args):
    try:
        call(*args)
        error = 0
    except OSError as e:
        error = e.errno
    kind = KINDS.get(call)
    if kind is not None:
        path = args[1] if kind in ("rename", "link", "symlink") else args[0]
        LOG.append((kind, path, error))
    return error


def flush_log():
    print("LOG " + json.dumps(LOG))
    sys.stdout.flush()


def together(*bodies):
    """Starts every body at once on its own thread and waits for all."""
    start = threading.Barrier(len(bodies))

    def at(body):
        def go():
            start.wait()
            body()
        return go

    threads = [threading.Thread(target=at(b)) for b in bodies]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def forked(body):
    """Runs body in a second process; returns a function that waits for it."""
    pid = os.fork()
    if pid == 0:
        try:
            LOG.clear()
            body()
            flush_log()
        finally:
            os._exit(0)
    return lambda: os.waitpid(pid, 0)


def exclusive(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    os.close(fd)


def created(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
    os.close(fd)


def readall(path):
    with open(path) as f:
        return f.read()


KINDS.update({
    exclusive: "excl", created: "create", os.mkdir: "mkdir", os.unlink: "remove", os.rmdir: "remove",
    os.rename: "rename", os.link: "link", os.symlink: "symlink", os.stat: "look", os.lstat: "look",
    os.access: "look", os.readlink: "look", readall: "open", os.chmod: "change", os.utime: "change",
    os.truncate: "change",
})


# ---- Cases --------------------------------------------------------------------------------------------------------
# Each: setup(ws), run() -> facts, change(ws) -> the path a commit changed.


def base_setup(ws):
    write(os.path.join(ws, "in/input"), "input\n")


def base_change(ws):
    write(os.path.join(ws, "in/input"), "other\n")
    return "in/input"


def read_input():
    return readall("in/input")


class Parent:
    """Rows: open O_CREAT, mkdir, rename, link, symlink into a directory another thread makes at the same time."""

    setup = staticmethod(base_setup)
    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()
        write("seed", "seed\n")

        def maker(i):
            def body():
                for j in range(ROUNDS // 4):
                    d = f"o/{j}/{i % 2}/{j % 3}"
                    for k in range(1, 5):
                        part = "/".join(d.split("/")[:k])
                        if k <= len(d.split("/")):
                            quiet(os.mkdir, part)
                    quiet(created, f"{d}/f{i}")
                    quiet(os.symlink, "seed", f"{d}/s{i}")
                    quiet(os.link, "seed", f"{d}/h{i}")
                    write(f"t{i}.{j}", "t\n")
                    quiet(os.rename, f"t{i}.{j}", f"{d}/r{i}")
            return body

        together(*[maker(i) for i in range(8)])
        return {}


class Exclusive:
    """Rows: create-exclusive, mkdir, symlink, link, unlink, rmdir on the run's own names, made and removed by two
    threads and a second process at once."""

    setup = staticmethod(base_setup)
    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()
        write("hsrc", "h\n")

        def maker():
            for _ in range(ROUNDS):
                quiet(exclusive, "x")
                quiet(os.mkdir, "d")
                quiet(os.symlink, "hsrc", "s")
                quiet(os.link, "hsrc", "h")

        def remover():
            for _ in range(ROUNDS):
                quiet(os.unlink, "x")
                quiet(os.rmdir, "d")
                quiet(os.unlink, "s")
                quiet(os.unlink, "h")

        wait = forked(remover)
        together(maker, remover)
        wait()
        return {}


class ExclusiveTracked:
    """Rows: create-exclusive and unlink on a file the commit holds: the first call that finds it there decides
    what the run read."""

    @staticmethod
    def setup(ws):
        base_setup(ws)
        write(os.path.join(ws, "t/x"), "tracked\n")

    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()

        def maker():
            for _ in range(ROUNDS):
                quiet(exclusive, "t/x")

        def remover():
            for _ in range(ROUNDS):
                quiet(os.unlink, "t/x")

        together(maker, remover)
        return {}


class Atomic:
    """Rows: rename onto a name, open to read and stat of it, while writers replace it (an atomic write)."""

    @staticmethod
    def setup(ws):
        base_setup(ws)
        write(os.path.join(ws, "out/keep"), "keep\n")

    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()

        def writer(i):
            def body():
                for j in range(ROUNDS):
                    write(f"out/.t{i}.{os.getpid()}", f"{i} {j}\n")
                    quiet(os.rename, f"out/.t{i}.{os.getpid()}", "out/x")
            return body

        def reader():
            for _ in range(ROUNDS):
                quiet(readall, "out/x")
                quiet(os.stat, "out/x")

        wait = forked(writer(9))
        together(writer(0), writer(1), reader, reader)
        wait()
        return {}


class RenameSource:
    """Rows: rename whose source another thread moves first."""

    setup = staticmethod(base_setup)
    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()
        won = {"a": 0, "b": 0}
        for j in range(ROUNDS // 4):
            write(f"s{j}", "s\n")
            got = {}

            def mover(to):
                def body():
                    got[to] = quiet(os.rename, f"s{j}", f"{to}{j}")
                return body

            together(mover("a"), mover("b"))
            for k, v in got.items():
                if v == 0:
                    won[k] += 1
        return won


class RemoveFull:
    """Rows: rmdir of a directory that holds files, unlink of a directory, rmdir of a file: the kernel refuses each,
    with no race."""

    @staticmethod
    def setup(ws):
        base_setup(ws)
        write(os.path.join(ws, "src/a"), "a\n")

    @staticmethod
    def change(ws):
        write(os.path.join(ws, "src/a"), "b\n")
        return "src/a"

    @staticmethod
    def run():
        answers = [quiet(os.rmdir, "src"), quiet(os.unlink, "src"), quiet(os.rmdir, "src/a")]
        write("out.txt", readall("src/a"))
        quiet(os.mkdir, "src")
        quiet(os.mkdir, "src/a/b")
        return {"answers": answers}


class Cwd:
    """Rows: every call with a relative path, whose directory another thread of the process changes (chdir)."""

    @staticmethod
    def setup(ws):
        base_setup(ws)
        write(os.path.join(ws, "A/f"), "A\n")
        write(os.path.join(ws, "B/f"), "B\n")

    @staticmethod
    def change(ws):
        # The commit changes the file the run read; the driver passes which one.
        name = os.environ["RACE_READ"]
        write(os.path.join(ws, name), "changed\n")
        return name

    @staticmethod
    def run():
        top = os.getcwd()
        os.chdir(f"{top}/A")
        stop = threading.Event()
        read = {}

        def flipper():
            while not stop.is_set():
                os.chdir(f"{top}/A")
                os.chdir(f"{top}/B")

        def reader():
            time.sleep(random.random() * 0.01)
            read["f"] = readall("f").strip()
            stop.set()

        together(flipper, reader)
        os.chdir(top)
        return {"read": f"{read['f']}/f"}


class Look:
    """Rows: stat, access, readlink, open to read, chmod, utime, truncate of a name another thread and a second
    process make and remove."""

    setup = staticmethod(base_setup)
    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()

        def churn():
            for _ in range(ROUNDS):
                quiet(created, "y")
                quiet(os.unlink, "y")
                quiet(os.mkdir, "y")
                quiet(os.rmdir, "y")

        def looker():
            for _ in range(ROUNDS):
                quiet(os.stat, "y")
                quiet(os.lstat, "y")
                quiet(os.access, "y", os.R_OK)
                quiet(os.readlink, "y")
                quiet(readall, "y")
                quiet(os.chmod, "y", 0o644)
                quiet(os.utime, "y")
                quiet(os.truncate, "y", 0)

        wait = forked(churn)
        together(churn, looker, looker)
        wait()
        return {}


class Connect:
    """Rows: connect to a socket path another thread binds at the same time."""

    setup = staticmethod(base_setup)
    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()
        tries = {"n": 0}

        def server():
            time.sleep(random.random() * 0.005)
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.bind("sock")
            s.listen(8)
            c, _ = s.accept()
            c.close()
            s.close()

        def client():
            while True:
                c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                tries["n"] += 1
                try:
                    c.connect("sock")
                    LOG.append(("connect", "sock", 0))
                    c.close()
                    return
                except OSError as e:
                    LOG.append(("connect", "sock", e.errno))
                    c.close()
                    if os.environ.get("RACE_BUSY") != "1":
                        time.sleep(0.001)

        together(server, client)
        os.unlink("sock")
        return {"tries": tries["n"]}


class Exec:
    """Rows: execve of a program another thread replaces and removes at the same time."""

    setup = staticmethod(base_setup)
    change = staticmethod(base_change)

    @staticmethod
    def run():
        read_input()
        stop = threading.Event()

        def replacer():
            n = 0
            while not stop.is_set():
                write(f".p{n}", "#!/bin/sh\nexit 0\n")
                os.chmod(f".p{n}", 0o755)
                os.rename(f".p{n}", "p")
                quiet(os.unlink, "p")
                n += 1

        def starter():
            ran = 0
            for _ in range(ROUNDS // 10):
                pid = os.fork()
                if pid == 0:
                    try:
                        os.execv("./p", ["./p"])
                    except OSError as e:
                        os._exit(100 + e.errno)
                _, status = os.waitpid(pid, 0)
                code = os.waitstatus_to_exitcode(status)
                LOG.append(("exec", "p", 0 if code == 0 else code - 100))
            stop.set()

        together(replacer, starter)
        return {}


CASES = {
    "parent": Parent,
    "exclusive": Exclusive,
    "exclusive-tracked": ExclusiveTracked,
    "atomic": Atomic,
    "rename-source": RenameSource,
    "remove-full": RemoveFull,
    "cwd": Cwd,
    "look": Look,
    "connect": Connect,
    "exec": Exec,
}

if __name__ == "__main__":
    what, case = sys.argv[1], CASES[sys.argv[2]]
    if what == "setup":
        case.setup(sys.argv[3])
    elif what == "change":
        print(case.change(sys.argv[3]))
    else:
        facts = case.run()
        flush_log()
        print(json.dumps(facts))
        sys.stdout.flush()
