/**
 * A program that reaches a file through one way of the kernel's, for the
 * tests of what a recorder writes down: `python3 probe.py <way>` reaches what
 * that way leads to and exits 0 when it finds what the repository holds in
 * {@link files}, 1 when it finds what {@link ways} says the change leaves, 2
 * when a call fails in a way no change explains, and 77 when this machine has
 * no such call (aarch64 has none of the calls that predate the `*at` ones).
 *
 * Calls Python has no function for are made by number: the kernel's for
 * x86_64 (`arch/x86/entry/syscalls/syscall_64.tbl`) and aarch64
 * (`include/uapi/asm-generic/unistd.h`), Linux 7.0.
 */

/** The program, to be written to a file and run by `python3`. */
export const program = String.raw`
import ctypes, os, platform, struct, sys, threading

libc = ctypes.CDLL(None, use_errno=True)
x86 = platform.machine() == "x86_64"
NR = {
    "open": (2, None), "openat": (257, 56), "openat2": (437, 437), "creat": (85, None), "stat": (4, None),
    "lstat": (6, None), "newfstatat": (262, 79), "statx": (332, 291), "access": (21, None), "faccessat": (269, 48),
    "faccessat2": (439, 439), "readlink": (89, None), "readlinkat": (267, 78), "statfs": (137, 43),
    "getxattr": (191, 8), "lgetxattr": (192, 9), "listxattr": (194, 11), "llistxattr": (195, 12),
    "getxattrat": (464, 464), "listxattrat": (465, 465), "file_getattr": (468, 468), "inotify_init1": (294, 26),
    "inotify_add_watch": (254, 27), "execve": (59, 221), "execveat": (322, 281), "chdir": (80, 49),
    "fchdir": (81, 50), "getdents": (78, None), "getdents64": (217, 61), "mkdir": (83, None), "mkdirat": (258, 34),
    "mknod": (133, None), "mknodat": (259, 33), "unlink": (87, None), "rmdir": (84, None), "unlinkat": (263, 35),
    "chmod": (90, None), "chown": (92, None), "lchown": (94, None), "utime": (132, None), "utimes": (235, None),
    "futimesat": (261, None), "utimensat": (280, 88), "truncate": (76, 45), "fchmodat": (268, 53),
    "fchmodat2": (452, 452), "fchownat": (260, 54), "setxattr": (188, 5), "lsetxattr": (189, 6),
    "removexattr": (197, 14), "lremovexattr": (198, 15), "setxattrat": (463, 463), "removexattrat": (466, 466),
    "file_setattr": (469, 469), "fchmod": (91, 52), "fchown": (93, 55), "rename": (82, None), "renameat": (264, 38),
    "renameat2": (316, 276), "link": (86, None), "linkat": (265, 37), "symlink": (88, None), "symlinkat": (266, 36),
    "fork": (57, None), "unshare": (272, 97), "dup": (32, 23), "pidfd_open": (434, 434), "io_uring_setup": (425, 425), "io_uring_enter": (426, 426),
    "seccomp": (317, 277), "mseal": (462, 462), "listns": (470, 470), "rseq_slice_yield": (471, 471),
    "name_to_handle_at": (303, 264), "open_by_handle_at": (304, 265), "chroot": (161, 51), "pivot_root": (155, 41),
    "mount": (165, 40), "umount2": (166, 39), "setns": (308, 268), "open_tree": (428, 428), "move_mount": (429, 429),
    "fsopen": (430, 430), "fsconfig": (431, 431), "fsmount": (432, 432), "fspick": (433, 433),
    "mount_setattr": (442, 442), "open_tree_attr": (467, 467), "fanotify_mark": (301, 263), "quotactl": (179, 60),
    "swapon": (167, 224), "swapoff": (168, 225), "acct": (163, 89), "uselib": (134, None), "bpf": (321, 280),
}
AT_FDCWD = -100
AT_SYMLINK_NOFOLLOW, AT_EACCESS, AT_REMOVEDIR, AT_SYMLINK_FOLLOW = 0x100, 0x200, 0x200, 0x400
AT_NO_AUTOMOUNT, AT_EMPTY_PATH, AT_STATX_FORCE_SYNC = 0x800, 0x1000, 0x2000
O_PATH = 0o10000000
RESOLVE = {"no-xdev": 0x01, "no-magiclinks": 0x02, "no-symlinks": 0x04, "beneath": 0x08, "in-root": 0x10,
           "cached": 0x20}
ENOENT, EEXIST, ELOOP, EAGAIN, ENOSYS = 2, 17, 40, 11, 38


class Skip(Exception):
    pass


def call(name, *args):
    number = NR[name][0 if x86 else 1]
    if number is None:
        raise Skip()
    converted = [ctypes.c_char_p(a.encode()) if isinstance(a, str) else a for a in args]
    ctypes.set_errno(0)
    result = libc.syscall(ctypes.c_long(number), *[ctypes.c_long(a) if isinstance(a, int) else a for a in converted])
    return result, ctypes.get_errno()


def done(result):
    sys.exit(0 if result else 1)


def text(path, dir_fd=None):
    with open(os.open(path, os.O_RDONLY, dir_fd=dir_fd), closefd=True) as f:
        return f.read()


def fd_text(fd):
    data = b""
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            return data.decode()
        data += chunk


def good(value):
    return value.strip() == "ok"


def exists_by(result):
    """An answer that found the name: success, or a failure other than finding nothing."""
    r, e = result
    if r < 0 and e == ENOSYS:
        raise Skip()
    return r >= 0 or e != ENOENT


def missing_by(result):
    r, e = result
    if r < 0 and e == ENOSYS:
        raise Skip()
    return r < 0 and e == ENOENT


def openat2(dirfd, path, resolve, flags=os.O_RDONLY):
    how = ctypes.create_string_buffer(struct.pack("QQQ", flags, 0, resolve))
    return call("openat2", dirfd, path, how, 24)


def stat_size(name, dirfd, path, flags):
    buf = ctypes.create_string_buffer(512)
    if name == "statx":
        r, e = call("statx", dirfd, path, flags, 0x7ff, buf)
        return None if r < 0 else struct.unpack_from("Q", buf.raw, 40)[0]
    if name in ("stat", "lstat"):
        r, e = call(name, path, buf)
    else:
        r, e = call(name, dirfd, path, buf, flags)
    return None if r < 0 else struct.unpack_from("q", buf.raw, 48)[0]


def readlink_of(dirfd, path):
    buf = ctypes.create_string_buffer(256)
    r, e = call("readlinkat", dirfd, path, buf, 256) if dirfd is not None else call("readlink", path, buf, 256)
    return None if r < 0 else buf.raw[:r].decode()


def names(fd, legacy=False):
    buf = ctypes.create_string_buffer(8192)
    found = []
    while True:
        r, e = call("getdents" if legacy else "getdents64", fd, buf, 8192)
        if r <= 0:
            break
        at = 0
        while at < r:
            if legacy:
                reclen = struct.unpack_from("H", buf.raw, at + 16)[0]
                name = buf.raw[at + 18:at + reclen].split(b"\0")[0].decode()
            else:
                reclen = struct.unpack_from("H", buf.raw, at + 16)[0]
                name = buf.raw[at + 19:at + reclen].split(b"\0")[0].decode()
            if name not in (".", ".."):
                found.append(name)
            at += reclen
    return sorted(found)


def directory(how):
    """A descriptor of the directory the listing ways look in, reached one way; None: the working directory."""
    if how == "opath":
        return os.open("data/dir2", O_PATH | os.O_DIRECTORY)
    if how == "fchdir":
        os.fchdir(os.open("data/dir2", O_PATH | os.O_DIRECTORY))
        return AT_FDCWD
    if how == "in-root":
        r, e = openat2(os.open("data", os.O_RDONLY | os.O_DIRECTORY), "/dir2", RESOLVE["in-root"],
                       os.O_RDONLY | os.O_DIRECTORY)
        if r < 0:
            sys.exit(2)
        return r
    if how == "dotdot":  # data/lnk -> sub/deep, so data/lnk/../dir3 is data/sub/dir3
        return os.open("data/lnk/../dir3", os.O_RDONLY | os.O_DIRECTORY)
    raise ValueError(how)


def by_dir(name, how):
    fd = directory(how)
    if name == "statx":
        return stat_size("statx", fd, "s.txt", 0) == 3
    if name == "faccessat2":
        return call("faccessat2", fd, "f", 0, AT_EACCESS)[0] == 0
    if name == "readlinkat":
        return readlink_of(fd, "l") == "x"
    if name == "getdents64":
        listed = fd if fd != AT_FDCWD else os.open(".", os.O_RDONLY | os.O_DIRECTORY)
        if how == "opath":
            listed = os.open(".", os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
        return names(listed) == ["f", "l", "s.txt"]
    raise ValueError(name)


def in_thread(body):
    out = []
    t = threading.Thread(target=lambda: out.append(body()))
    t.start()
    t.join()
    return out[0]


def ring_open(path, sqpoll=False):
    """Opens a path through io_uring's OPENAT, as the recorder cannot see; None where the ring is refused."""
    params = ctypes.create_string_buffer(120)
    if sqpoll:
        struct.pack_into("I", params, 8, 2)  # IORING_SETUP_SQPOLL
    ring, e = call("io_uring_setup", 4, params)
    if ring < 0:
        return None
    sq_entries, cq_entries = struct.unpack_from("II", params.raw, 0)
    sq_off = struct.unpack_from("IIIIIII", params.raw, 40)
    cq_off = struct.unpack_from("IIIIII", params.raw, 80)
    import mmap
    sq = mmap.mmap(ring, sq_off[6] + sq_entries * 4, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE, offset=0)
    cq = mmap.mmap(ring, cq_off[5] + cq_entries * 16, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE,
                   offset=0x8000000)
    sqes = mmap.mmap(ring, sq_entries * 64, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE, offset=0x10000000)
    name = ctypes.create_string_buffer(path.encode())
    sqe = struct.pack("BBHiQQIIQHHi", 18, 0, 0, AT_FDCWD, 0, ctypes.addressof(name), 0, os.O_RDONLY, 0, 0, 0, 0)
    sqes[0:len(sqe)] = sqe
    tail = struct.unpack_from("I", sq, sq_off[1])[0]
    mask = struct.unpack_from("I", sq, sq_off[2])[0]
    struct.pack_into("I", sq, sq_off[6] + (tail & mask) * 4, 0)
    struct.pack_into("I", sq, sq_off[1], tail + 1)
    # IORING_ENTER_GETEVENTS, and IORING_ENTER_SQ_WAKEUP for a ring whose own thread may sleep.
    r, e = call("io_uring_enter", ring, 1, 1, 3 if sqpoll else 1, 0, 0)
    if r < 0:
        return None
    head = struct.unpack_from("I", cq, cq_off[0])[0]
    cmask = struct.unpack_from("I", cq, cq_off[2])[0]
    res = struct.unpack_from("i", cq, cq_off[5] + (head & cmask) * 16 + 8)[0]
    return None if res < 0 else res


def execveat(opened, path, flags):
    """Starts a script by a descriptor: the shell reads it through /dev/fd, so the descriptor stays open in it."""
    fd = os.open(opened, os.O_RDONLY)
    os.set_inheritable(fd, True)
    call("execveat", fd, path, (ctypes.c_char_p * 2)(b"script.sh", None), (ctypes.c_char_p * 1)(None), flags)
    return False


def then_read(effect):
    """A call made for what it does to the run, then data/x.txt read as any open reads it."""
    def way():
        effect()
        return good(text("data/x.txt"))
    return way


def missing_then(name, *args):
    """A call on data/none, which is not there: it finds nothing, unless the change put it there."""
    return lambda: missing_by(call(name, *args))


def exists_then(name, *args):
    """A call that makes data/flag, which is there: it finds it, unless the change took it away."""
    def way():
        result = call(name, *args)
        if result[0] >= 0:
            for undo in (lambda: os.unlink("data/flag"), lambda: os.rmdir("data/flag")):
                try:
                    undo()
                except OSError:
                    pass
        return result[0] < 0 and result[1] == EEXIST
    return way


def resolved(form, path, base="data/root", flags=os.O_RDONLY):
    def way():
        resolve = 0
        for part in form.split("+"):
            resolve |= RESOLVE[part]
        r, e = openat2(os.open(base, os.O_RDONLY | os.O_DIRECTORY), path, resolve, flags)
        if r < 0 and e == EAGAIN and resolve & RESOLVE["cached"]:  # not in the cache: asked again, as io_uring does
            r, e = openat2(os.open(base, os.O_RDONLY | os.O_DIRECTORY), path, resolve & ~RESOLVE["cached"], flags)
        if r < 0 and e == ELOOP and resolve & RESOLVE["no-symlinks"]:
            return True  # the link is there, as the repository holds it
        return r >= 0 and good(fd_text(r))
    return way


def fork_then_read(kind):
    def way():
        if kind == "clone":
            pid = os.fork()
        else:
            pid, e = call("fork")
        if pid == 0:
            os._exit(0 if good(text("data/x.txt")) else 1)
        _, status = os.waitpid(pid, 0)
        return os.waitstatus_to_exitcode(status) == 0
    return way


def spawn_read():
    pid = os.posix_spawn("/bin/cat", ["cat", "data/x.txt"], dict(os.environ),
                         file_actions=[(os.POSIX_SPAWN_OPEN, 1, "build/spawned", os.O_WRONLY | os.O_CREAT, 0o644)])
    os.waitpid(pid, 0)
    return good(text("build/spawned"))


def deep_cwd():
    root = os.getcwd()
    os.makedirs("build", exist_ok=True)
    os.chdir("build")
    for i in range(45):
        name = "d%02d" % i + "x" * 97
        os.makedirs(name, exist_ok=True)
        os.chdir(name)
    if os.path.lexists("link"):
        os.unlink("link")
    os.symlink(os.path.join(root, "data/x.txt"), "link")
    return good(text("link"))


def relative(path):
    """Opens a relative path by the oldest call where there is one, which names no directory beside it."""
    if x86:
        r, e = call("open", path, os.O_RDONLY)
        return r >= 0 and good(fd_text(r))
    return good(text(path))


def unshared_cwd():
    """A thread that stops sharing the working directory moves it; the first thread's own stays."""
    def body():
        call("unshare", 0x200)  # CLONE_FS
        os.chdir("data/dir")
    in_thread(body)
    return relative("data/x.txt")


def shared_cwd():
    """A thread moves the working directory it shares; the first thread opens from there."""
    in_thread(lambda: os.chdir("data/dir"))
    return relative("a.txt")


def handler_then_read():
    import signal
    signal.signal(signal.SIGALRM, lambda s, f: None)
    signal.siginterrupt(signal.SIGALRM, True)
    return good(text("data/x.txt"))


def own_filter_then_read():
    prog = (ctypes.c_uint64 * 1)(0x7fff000000000006)  # BPF_RET|BPF_K SECCOMP_RET_ALLOW
    fprog = struct.pack("HxxxxxxQ", 1, ctypes.addressof(prog))
    buf = ctypes.create_string_buffer(fprog)
    libc.prctl(38, 1, 0, 0, 0)  # PR_SET_NO_NEW_PRIVS
    call("seccomp", 1, 0, buf)
    return good(text("data/x.txt"))


def ring_then_read(sqpoll):
    def way():
        fd = ring_open("data/x.txt", sqpoll)
        return good(fd_text(fd) if fd is not None else text("data/x.txt"))
    return way


def namespace_then_read(mounted):
    def way():
        r, e = call("unshare", 0x10000000 | (0x20000 if mounted else 0))  # CLONE_NEWUSER, CLONE_NEWNS
        if r == 0 and mounted:
            call("mount", "none", "data/dir", "tmpfs", 0, 0)
        return good(text("data/x.txt"))
    return way


def long_name(extra):
    def way():
        name = "data/" + "./" * ((4095 + extra - len("data/x.txt")) // 2) + "x.txt"
        try:
            return good(text(name))
        except OSError:
            return good(text("data/x.txt"))
    return way


def link_then_read(flags):
    def way():
        if os.path.lexists("build/h"):
            os.unlink("build/h")
        if flags == AT_EMPTY_PATH:
            r, e = call("linkat", os.open("data/x.txt", os.O_RDONLY), "", AT_FDCWD, "build/h", flags)
        else:
            r, e = call("linkat", AT_FDCWD, "data/link", AT_FDCWD, "build/h", flags)
        return good(text("build/h") if r == 0 else text("data/x.txt"))
    return way


def made_link_in_root():
    """A link the step makes to "/sub/y.txt" leads, inside data/root, to data/root/sub/y.txt."""
    if not os.path.lexists("data/root/abs"):
        os.symlink("/sub/y.txt", "data/root/abs")
    return resolved("in-root", "abs")()


def exchange_directories():
    r, e = call("renameat2", AT_FDCWD, "data/da", AT_FDCWD, "data/db", 2)
    if r != 0:
        sys.exit(2)
    value = text("data/da/x.txt")
    call("renameat2", AT_FDCWD, "data/da", AT_FDCWD, "data/db", 2)
    return good(value)


def by_fd(name):
    def way():
        fd = os.open("data/x.txt", os.O_RDONLY)
        if name == "fchmod":
            call("fchmod", fd, 0o644)
        elif name == "fchown":
            call("fchown", fd, os.getuid(), os.getgid())
        else:
            call("utimensat", fd, 0, 0, 0)
        return good(fd_text(fd))
    return way


def exchange():
    r, e = call("renameat2", AT_FDCWD, "data/ya.txt", AT_FDCWD, "data/yb.txt", 2)
    if r != 0:
        sys.exit(2)
    value = text("data/ya.txt")
    call("renameat2", AT_FDCWD, "data/ya.txt", AT_FDCWD, "data/yb.txt", 2)
    return good(value)


def no_replace():
    os.makedirs("build", exist_ok=True)
    open("build/new", "w").close()
    r, e = call("renameat2", AT_FDCWD, "build/new", AT_FDCWD, "data/flag", 1)
    if r == 0:
        os.rename("data/flag", "build/new")
    return r < 0 and e == EEXIST


def socket_way(kind):
    import socket
    def way():
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if kind == "connect":
            try:
                s.connect("data/none")
            except FileNotFoundError:
                return True
            except OSError:
                return False
            return False
        try:
            s.bind("data/flag")
        except OSError:
            return True
        os.unlink("data/flag")
        return False
    return way


def vfork_read():
    import subprocess
    # dash starts a program that is not its last command with vfork.
    done = subprocess.run(["/bin/dash", "-c", "/bin/cat data/x.txt > build/v; true"])
    return done.returncode == 0 and good(text("build/v"))


def handle_way(name):
    def way():
        handle = ctypes.create_string_buffer(struct.pack("Ii", 128, 0) + b"\0" * 128)
        mount_id = ctypes.c_int(0)
        if name == "name_to_handle_at":
            call("name_to_handle_at", AT_FDCWD, "data/x.txt", handle, ctypes.addressof(mount_id), 0)
        else:
            call("open_by_handle_at", AT_FDCWD, handle, os.O_RDONLY)
        return good(text("data/x.txt"))
    return way


ways = {
    # Opens.
    "open": lambda: (lambda r: r[0] >= 0 and good(fd_text(r[0])))(call("open", "data/x.txt", os.O_RDONLY)),
    "openat": lambda: good(text("data/x.txt")),
    "openat2": lambda: (lambda r: r[0] >= 0 and good(fd_text(r[0])))(openat2(AT_FDCWD, "data/x.txt", 0)),
    "creat": missing_then("creat", "data/none/c", 0o644),
    "opath": lambda: good(text("x.txt", dir_fd=os.open("data", O_PATH | os.O_DIRECTORY))),
    "dotdot": lambda: good(text("data/lnk/../d2/x.txt")),
    "fchdir": lambda: (os.fchdir(os.open("data/dir", O_PATH | os.O_DIRECTORY)), good(text("a.txt")))[1],
    "chdir": lambda: (os.chdir("data/dir"), good(text("a.txt")))[1],
    "threads-share-cwd": shared_cwd,
    "threads-own-cwd": unshared_cwd,
    "deep-cwd": deep_cwd,
    "name-of-4095-bytes": long_name(0),
    "name-of-4100-bytes": long_name(6),
    # openat2 and each RESOLVE flag, alone and through a link.
    "in-root": resolved("in-root", "/x.txt"),
    "in-root-up": resolved("in-root", "../../x.txt"),
    "in-root-link": resolved("in-root", "sub/back"),
    "in-root-made-link": made_link_in_root,
    "beneath": resolved("beneath", "sub/y.txt"),
    "beneath-link": resolved("beneath", "rel"),
    "no-symlinks": resolved("no-symlinks", "x.txt"),
    "no-symlinks-link": resolved("no-symlinks", "rel"),
    "no-magiclinks": resolved("no-magiclinks", "x.txt"),
    "no-magiclinks-link": resolved("no-magiclinks", "rel"),
    "no-xdev": resolved("no-xdev", "x.txt"),
    "no-xdev-link": resolved("no-xdev", "rel"),
    "cached": resolved("cached", "x.txt"),
    "cached-link": resolved("cached", "rel"),
    "in-root-no-symlinks": resolved("in-root+no-xdev+no-magiclinks", "/x.txt"),
    # Lookups.
    "stat": lambda: stat_size("stat", None, "data/size.txt", 0) == 3,
    "lstat": lambda: stat_size("lstat", None, "data/link", 0) == 5,
    "newfstatat": lambda: stat_size("newfstatat", AT_FDCWD, "data/size.txt", 0) == 3,
    "newfstatat-nofollow": lambda: stat_size("newfstatat", AT_FDCWD, "data/link", AT_SYMLINK_NOFOLLOW) == 5,
    "newfstatat-empty-path": lambda: stat_size("newfstatat", os.open("data/size.txt", O_PATH), "", AT_EMPTY_PATH) == 3,
    "statx": lambda: stat_size("statx", AT_FDCWD, "data/size.txt", 0) == 3,
    "statx-nofollow": lambda: stat_size("statx", AT_FDCWD, "data/link", AT_SYMLINK_NOFOLLOW) == 5,
    "statx-empty-path": lambda: stat_size("statx", os.open("data/size.txt", O_PATH), "", AT_EMPTY_PATH) == 3,
    "statx-force-sync": lambda: stat_size("statx", AT_FDCWD, "data/size.txt", AT_STATX_FORCE_SYNC) == 3,
    "statx-no-automount": lambda: stat_size("statx", AT_FDCWD, "data/size.txt", AT_NO_AUTOMOUNT) == 3,
    "access": lambda: call("access", "data/flag", 0)[0] == 0,
    "faccessat": lambda: call("faccessat", AT_FDCWD, "data/flag", 0)[0] == 0,
    "faccessat2": lambda: call("faccessat2", AT_FDCWD, "data/flag", 0, AT_EACCESS)[0] == 0,
    "faccessat2-empty-path": lambda: call("faccessat2", os.open("data/flag", O_PATH), "", 0, AT_EMPTY_PATH)[0] == 0,
    "readlink": lambda: readlink_of(None, "data/link") == "x.txt",
    "readlinkat": lambda: readlink_of(AT_FDCWD, "data/link") == "x.txt",
    "statfs": lambda: call("statfs", "data/flag", ctypes.create_string_buffer(256))[0] == 0,
    "getxattr": lambda: exists_by(call("getxattr", "data/flag", "user.none", 0, 0)),
    "lgetxattr": lambda: exists_by(call("lgetxattr", "data/flag", "user.none", 0, 0)),
    "listxattr": lambda: exists_by(call("listxattr", "data/flag", 0, 0)),
    "llistxattr": lambda: exists_by(call("llistxattr", "data/flag", 0, 0)),
    "getxattrat": lambda: exists_by(call("getxattrat", AT_FDCWD, "data/flag", 0, "user.none",
                                         ctypes.create_string_buffer(16), 16)),
    "listxattrat": lambda: exists_by(call("listxattrat", AT_FDCWD, "data/flag", 0, 0, 0)),
    "file_getattr": lambda: exists_by(call("file_getattr", AT_FDCWD, "data/flag", ctypes.create_string_buffer(64), 24, 0)),
    "inotify_add_watch": lambda: call("inotify_add_watch", call("inotify_init1", 0)[0], "data/flag", 0xfff)[0] >= 0,
    # Programs.
    "execve": lambda: os.execv("data/script.sh", ["script.sh"]),
    "execveat": lambda: execveat("data", "script.sh", 0),
    "execveat-empty-path": lambda: execveat("data/script.sh", "", AT_EMPTY_PATH),
    # Listings.
    "getdents": lambda: names(os.open("data/dir", os.O_RDONLY | os.O_DIRECTORY), legacy=True) == ["a.txt"],
    "getdents64": lambda: names(os.open("data/dir", os.O_RDONLY | os.O_DIRECTORY)) == ["a.txt"],
    # A directory's descriptor copied to another number, and a file reached below that one through /dev/fd.
    "dup": lambda: good(text("/dev/fd/%d/x.txt" % call("dup", os.open("data", os.O_RDONLY | os.O_DIRECTORY))[0])),
    "dup2": lambda: (os.dup2(os.open("data", os.O_RDONLY | os.O_DIRECTORY), 57), good(text("/dev/fd/57/x.txt")))[1],
    "dup3": lambda: (os.dup2(os.open("data", os.O_RDONLY | os.O_DIRECTORY), 58, inheritable=False),
                     good(text("/dev/fd/58/x.txt")))[1],
    # Names made where one is: each finds it, unless the change took it away.
    "mkdir": exists_then("mkdir", "data/flag", 0o755),
    "mkdirat": exists_then("mkdirat", AT_FDCWD, "data/flag", 0o755),
    "mknod": exists_then("mknod", "data/flag", 0o10644, 0),
    "mknodat": exists_then("mknodat", AT_FDCWD, "data/flag", 0o10644, 0),
    "symlink": exists_then("symlink", "x.txt", "data/flag"),
    "symlinkat": exists_then("symlinkat", "x.txt", AT_FDCWD, "data/flag"),
    "link": exists_then("link", "data/x.txt", "data/flag"),
    "linkat": exists_then("linkat", AT_FDCWD, "data/x.txt", AT_FDCWD, "data/flag", 0),
    "linkat-follow": link_then_read(AT_SYMLINK_FOLLOW),
    "linkat-nofollow": link_then_read(AT_SYMLINK_NOFOLLOW),
    "linkat-empty-path": link_then_read(AT_EMPTY_PATH),
    "bind": socket_way("bind"),
    "connect": socket_way("connect"),
    # Names taken away, moved or changed where none is: each finds nothing, unless the change put it there.
    "unlink": missing_then("unlink", "data/none"),
    "rmdir": missing_then("rmdir", "data/none"),
    "unlinkat": missing_then("unlinkat", AT_FDCWD, "data/none", 0),
    "unlinkat-removedir": missing_then("unlinkat", AT_FDCWD, "data/none", AT_REMOVEDIR),
    "rename": missing_then("rename", "data/none", "data/none2"),
    "renameat": missing_then("renameat", AT_FDCWD, "data/none", AT_FDCWD, "data/none2"),
    "renameat2": missing_then("renameat2", AT_FDCWD, "data/none", AT_FDCWD, "data/none2", 0),
    "exchange": exchange,
    "exchange-directories": exchange_directories,
    "no-replace": no_replace,
    "chmod": missing_then("chmod", "data/none", 0o644),
    "chown": missing_then("chown", "data/none", os.getuid(), os.getgid()),
    "lchown": missing_then("lchown", "data/none", os.getuid(), os.getgid()),
    "utime": missing_then("utime", "data/none", 0),
    "utimes": missing_then("utimes", "data/none", 0),
    "futimesat": missing_then("futimesat", AT_FDCWD, "data/none", 0),
    "utimensat": missing_then("utimensat", AT_FDCWD, "data/none", 0, 0),
    "utimensat-nofollow": missing_then("utimensat", AT_FDCWD, "data/none", 0, AT_SYMLINK_NOFOLLOW),
    "truncate": missing_then("truncate", "data/none", 0),
    "fchmodat": missing_then("fchmodat", AT_FDCWD, "data/none", 0o644),
    "fchmodat2": missing_then("fchmodat2", AT_FDCWD, "data/none", 0o644, 0),
    "fchownat": missing_then("fchownat", AT_FDCWD, "data/none", os.getuid(), os.getgid(), 0),
    "setxattr": missing_then("setxattr", "data/none", "user.x", "v", 1, 0),
    "lsetxattr": missing_then("lsetxattr", "data/none", "user.x", "v", 1, 0),
    "removexattr": missing_then("removexattr", "data/none", "user.x"),
    "lremovexattr": missing_then("lremovexattr", "data/none", "user.x"),
    "setxattrat": missing_then("setxattrat", AT_FDCWD, "data/none", 0, "user.x", ctypes.create_string_buffer(24), 24),
    "removexattrat": missing_then("removexattrat", AT_FDCWD, "data/none", 0, "user.x"),
    "file_setattr": missing_then("file_setattr", AT_FDCWD, "data/none", ctypes.create_string_buffer(64), 24, 0),
    "fchmod": by_fd("fchmod"),
    "fchown": by_fd("fchown"),
    "utimensat-descriptor": by_fd("utimensat"),
    # Processes, rings and filters.
    "clone": fork_then_read("clone"),
    "fork": fork_then_read("fork"),
    "vfork": vfork_read,
    "clone3": spawn_read,
    "rt_sigaction": handler_then_read,
    "seccomp": own_filter_then_read,
    "io_uring": ring_then_read(False),
    "io_uring-sqpoll": ring_then_read(True),
    "pidfd_open": then_read(lambda: call("pidfd_open", os.getpid(), 0)),
    "mseal": then_read(lambda: call("mseal", 0, 0, 0)),
    "listns": then_read(lambda: call("listns", 0, 0, 0, 0)),
    "rseq_slice_yield": then_read(lambda: call("rseq_slice_yield")),
    "unknown-call": then_read(lambda: libc.syscall(ctypes.c_long(472))),
    "unshare-namespace": namespace_then_read(False),
    "mount-in-namespace": namespace_then_read(True),
    # Calls that name a file no record can hold.
    "name_to_handle_at": handle_way("name_to_handle_at"),
    "open_by_handle_at": handle_way("open_by_handle_at"),
    "chroot": then_read(lambda: call("chroot", "data/dir")),
    "pivot_root": then_read(lambda: call("pivot_root", "data/dir", "data/dir")),
    "mount": then_read(lambda: call("mount", "none", "data/dir", "tmpfs", 0, 0)),
    "umount2": then_read(lambda: call("umount2", "data/dir", 0)),
    "setns": then_read(lambda: call("setns", -1, 0)),
    "open_tree": then_read(lambda: call("open_tree", AT_FDCWD, "data", 0)),
    "move_mount": then_read(lambda: call("move_mount", -1, "", AT_FDCWD, "data/dir", 0)),
    "fsopen": then_read(lambda: call("fsopen", "tmpfs", 0)),
    "fsconfig": then_read(lambda: call("fsconfig", -1, 0, 0, 0, 0)),
    "fsmount": then_read(lambda: call("fsmount", -1, 0, 0)),
    "fspick": then_read(lambda: call("fspick", AT_FDCWD, "data", 0)),
    "mount_setattr": then_read(lambda: call("mount_setattr", AT_FDCWD, "data", 0, 0, 0)),
    "open_tree_attr": then_read(lambda: call("open_tree_attr", AT_FDCWD, "data", 0, 0, 0)),
    "fanotify_mark": then_read(lambda: call("fanotify_mark", -1, 1, 1, AT_FDCWD, "data")),
    "quotactl": then_read(lambda: call("quotactl", 0, "data", 0, 0)),
    "swapon": then_read(lambda: call("swapon", "data/x.txt", 0)),
    "swapoff": then_read(lambda: call("swapoff", "data/x.txt")),
    "acct": then_read(lambda: call("acct", "data/acct")),
    "uselib": then_read(lambda: call("uselib", "data/x.txt")),
    "bpf": then_read(lambda: call("bpf", 7, 0, 0)),
}
for how in ("opath", "fchdir", "in-root", "dotdot"):
    for name in ("statx", "faccessat2", "readlinkat", "getdents64"):
        ways[name + "-in-a-directory-by-" + how] = (lambda n, h: lambda: by_dir(n, h))(name, how)

way = sys.argv[1]
try:
    os.makedirs("build", exist_ok=True)
    result = ways[way]()
except Skip:
    sys.exit(77)
done(result)
`

/** The repository a probe reads: each path with what it holds while every way finds `ok`. A link is `-> target`. */
export const files: ReadonlyArray<readonly [path: string, text: string]> = [
  ["data/x.txt", "ok\n"],
  ["data/size.txt", "ok\n"],
  ["data/flag", "here\n"],
  ["data/link", "-> x.txt"],
  ["data/script.sh", "#!/bin/sh\nexit 0\n"],
  ["data/dir/a.txt", "ok\n"],
  ["data/dir2/s.txt", "ok\n"],
  ["data/dir2/f", "here\n"],
  ["data/dir2/l", "-> x"],
  ["data/sub/dir3/s.txt", "ok\n"],
  ["data/sub/dir3/f", "here\n"],
  ["data/sub/dir3/l", "-> x"],
  ["data/sub/deep/.keep", ""],
  ["data/lnk", "-> sub/deep"],
  ["data/sub/d2/x.txt", "ok\n"],
  ["data/d2/x.txt", "ok\n"],
  ["data/root/x.txt", "ok\n"],
  ["data/root/sub/y.txt", "ok\n"],
  ["data/root/sub/back", "-> ../../../x.txt"],
  ["data/root/rel", "-> sub/y.txt"],
  ["data/ya.txt", "zz\n"],
  ["data/yb.txt", "ok\n"],
  ["data/da/x.txt", "zz\n"],
  ["data/db/x.txt", "ok\n"]
]

/** A change a commit makes: the path, and what it then holds (`undefined`: removed; `/`: an empty directory). */
export type Change = readonly [path: string, text: string | undefined]

const bad = (path: string): Change => [path, "bad!\n"]
const x = bad("data/x.txt")
const none: Change = ["data/none", "here\n"]
const flagGone: Change = ["data/flag", undefined]

/**
 * What a recorder must do with a way: follow it (`stored`: the run is reused while what it read holds, and runs
 * again after the change), or store nothing and say why (a reason). One for both recorders, or one for each.
 */
export type Expected = Verdict | { readonly strace: Verdict | "either"; readonly observe: Verdict }

/** Reused while what the run read holds, or nothing stored, with the start of the reason. */
export type Verdict = "stored" | { readonly reason: string }

/** One way: the call and the form of it the table follows or refuses, the change that must run it again, and what the recorders must do. */
export interface Way {
  readonly call: string
  readonly form: string
  readonly change: Change
  readonly expected: Expected
}

const stored = "stored" as const
const refused = (form: string): { readonly reason: string } => ({
  reason: `it reached a file in a way the recorder cannot follow: ${form}`
})
/**
 * A call newer than strace 6.8, which prints it by its number with no path: such a strace refuses it, and one that
 * names it follows it.
 */
const newer: Expected = { strace: "either", observe: stored }
/** A refused call that fails here for want of a right: strace sees it fail and the run read nothing through it. */
const failsHere = (form: string): Expected => ({ strace: stored, observe: refused(form) })

/** Every way, by the name `probe.py` takes. */
export const ways: { readonly [way: string]: Way } = {
  "open": { call: "open", form: "a path", change: x, expected: stored },
  "openat": { call: "openat", form: "a path from the working directory", change: x, expected: stored },
  "openat2": { call: "openat2", form: "no RESOLVE flag", change: x, expected: stored },
  "creat": { call: "creat", form: "in a directory not there", change: ["data/none", "/"], expected: stored },
  "opath": { call: "openat", form: "below an O_PATH descriptor", change: x, expected: stored },
  "dotdot": { call: "openat", form: "`..` through a link", change: bad("data/sub/d2/x.txt"), expected: stored },
  "fchdir": {
    call: "fchdir",
    form: "to an O_PATH descriptor, then a relative open",
    change: bad("data/dir/a.txt"),
    expected: stored
  },
  "chdir": { call: "chdir", form: "then a relative open", change: bad("data/dir/a.txt"), expected: stored },
  "threads-share-cwd": {
    call: "chdir",
    form: "by a thread that shares its working directory (CLONE_FS)",
    change: bad("data/dir/a.txt"),
    expected: stored
  },
  "threads-own-cwd": {
    call: "unshare",
    form: "CLONE_FS, then chdir by that thread",
    change: x,
    expected: stored
  },
  "deep-cwd": {
    call: "openat",
    form: "from a working directory deeper than PATH_MAX",
    change: x,
    expected: {
      strace: refused("a path longer than 4095 bytes"),
      observe: { reason: "its trace does not say which directory" }
    }
  },
  "name-of-4095-bytes": {
    call: "openat",
    form: "a name of 4,095 bytes",
    change: x,
    expected: { strace: stored, observe: refused("a path longer than 4095 bytes") }
  },
  "name-of-4100-bytes": { call: "openat", form: "a name longer than PATH_MAX (fails)", change: x, expected: stored },
  "in-root": { call: "openat2", form: "RESOLVE_IN_ROOT", change: bad("data/root/x.txt"), expected: stored },
  "in-root-up": {
    call: "openat2",
    form: "RESOLVE_IN_ROOT, `..` at the root",
    change: bad("data/root/x.txt"),
    expected: stored
  },
  "in-root-link": {
    call: "openat2",
    form: "RESOLVE_IN_ROOT through a link",
    change: bad("data/root/x.txt"),
    expected: stored
  },
  "in-root-made-link": {
    call: "openat2",
    form: "RESOLVE_IN_ROOT through an absolute link the step made",
    change: bad("data/root/sub/y.txt"),
    expected: stored
  },
  "beneath": { call: "openat2", form: "RESOLVE_BENEATH", change: bad("data/root/sub/y.txt"), expected: stored },
  "beneath-link": {
    call: "openat2",
    form: "RESOLVE_BENEATH through a link",
    change: bad("data/root/sub/y.txt"),
    expected: stored
  },
  "no-symlinks": { call: "openat2", form: "RESOLVE_NO_SYMLINKS", change: bad("data/root/x.txt"), expected: stored },
  "no-symlinks-link": {
    call: "openat2",
    form: "RESOLVE_NO_SYMLINKS at a link",
    change: bad("data/root/rel"),
    expected: stored
  },
  "no-magiclinks": { call: "openat2", form: "RESOLVE_NO_MAGICLINKS", change: bad("data/root/x.txt"), expected: stored },
  "no-magiclinks-link": {
    call: "openat2",
    form: "RESOLVE_NO_MAGICLINKS through a link",
    change: bad("data/root/sub/y.txt"),
    expected: stored
  },
  "no-xdev": { call: "openat2", form: "RESOLVE_NO_XDEV", change: bad("data/root/x.txt"), expected: stored },
  "no-xdev-link": {
    call: "openat2",
    form: "RESOLVE_NO_XDEV through a link",
    change: bad("data/root/sub/y.txt"),
    expected: stored
  },
  "cached": { call: "openat2", form: "RESOLVE_CACHED", change: bad("data/root/x.txt"), expected: stored },
  "cached-link": {
    call: "openat2",
    form: "RESOLVE_CACHED through a link",
    change: bad("data/root/sub/y.txt"),
    expected: stored
  },
  "in-root-no-symlinks": {
    call: "openat2",
    form: "RESOLVE_IN_ROOT with RESOLVE_NO_XDEV and RESOLVE_NO_MAGICLINKS",
    change: bad("data/root/x.txt"),
    expected: stored
  },
  "stat": { call: "stat", form: "a file's size", change: bad("data/size.txt"), expected: stored },
  "lstat": { call: "lstat", form: "a link's size", change: ["data/link", "-> xx.txt"], expected: stored },
  "newfstatat": { call: "newfstatat", form: "a file's size", change: bad("data/size.txt"), expected: stored },
  "newfstatat-nofollow": {
    call: "newfstatat",
    form: "AT_SYMLINK_NOFOLLOW",
    change: ["data/link", "-> xx.txt"],
    expected: stored
  },
  "newfstatat-empty-path": {
    call: "newfstatat",
    form: "AT_EMPTY_PATH of an O_PATH descriptor",
    change: bad("data/size.txt"),
    expected: stored
  },
  "statx": { call: "statx", form: "a file's size", change: bad("data/size.txt"), expected: stored },
  "statx-nofollow": {
    call: "statx",
    form: "AT_SYMLINK_NOFOLLOW",
    change: ["data/link", "-> xx.txt"],
    expected: stored
  },
  "statx-empty-path": {
    call: "statx",
    form: "AT_EMPTY_PATH of an O_PATH descriptor",
    change: bad("data/size.txt"),
    expected: stored
  },
  "statx-force-sync": { call: "statx", form: "AT_STATX_FORCE_SYNC", change: bad("data/size.txt"), expected: stored },
  "statx-no-automount": { call: "statx", form: "AT_NO_AUTOMOUNT", change: bad("data/size.txt"), expected: stored },
  "access": { call: "access", form: "a file there", change: flagGone, expected: stored },
  "faccessat": { call: "faccessat", form: "a file there", change: flagGone, expected: stored },
  "faccessat2": { call: "faccessat2", form: "AT_EACCESS", change: flagGone, expected: stored },
  "faccessat2-empty-path": { call: "faccessat2", form: "AT_EMPTY_PATH", change: flagGone, expected: stored },
  "readlink": { call: "readlink", form: "a link's target", change: ["data/link", "-> y.txt"], expected: stored },
  "readlinkat": { call: "readlinkat", form: "a link's target", change: ["data/link", "-> y.txt"], expected: stored },
  "statfs": { call: "statfs", form: "a file there", change: flagGone, expected: stored },
  "getxattr": { call: "getxattr", form: "a file there", change: flagGone, expected: stored },
  "lgetxattr": { call: "lgetxattr", form: "a file there", change: flagGone, expected: stored },
  "listxattr": { call: "listxattr", form: "a file there", change: flagGone, expected: stored },
  "llistxattr": { call: "llistxattr", form: "a file there", change: flagGone, expected: stored },
  "getxattrat": { call: "getxattrat", form: "a file there", change: flagGone, expected: newer },
  "listxattrat": { call: "listxattrat", form: "a file there", change: flagGone, expected: newer },
  "file_getattr": { call: "file_getattr", form: "a file there", change: flagGone, expected: newer },
  "inotify_add_watch": { call: "inotify_add_watch", form: "a file there", change: flagGone, expected: stored },
  "execve": { call: "execve", form: "a script", change: ["data/script.sh", "#!/bin/sh\nexit 1\n"], expected: stored },
  "execveat": {
    call: "execveat",
    form: "from a directory descriptor",
    change: ["data/script.sh", "#!/bin/sh\nexit 1\n"],
    expected: stored
  },
  "execveat-empty-path": {
    call: "execveat",
    form: "AT_EMPTY_PATH of a descriptor",
    change: ["data/script.sh", "#!/bin/sh\nexit 1\n"],
    expected: stored
  },
  "getdents": { call: "getdents", form: "a directory", change: ["data/dir/b.txt", "new\n"], expected: stored },
  "getdents64": { call: "getdents64", form: "a directory", change: ["data/dir/b.txt", "new\n"], expected: stored },
  "dup": { call: "dup", form: "a directory's descriptor, then /dev/fd/<n>/x below it", change: x, expected: stored },
  "dup2": { call: "dup2", form: "a directory's descriptor, then /dev/fd/<n>/x below it", change: x, expected: stored },
  "dup3": { call: "dup3", form: "a directory's descriptor, then /dev/fd/<n>/x below it", change: x, expected: stored },
  "mkdir": { call: "mkdir", form: "where a file is", change: flagGone, expected: stored },
  "mkdirat": { call: "mkdirat", form: "where a file is", change: flagGone, expected: stored },
  "mknod": { call: "mknod", form: "where a file is", change: flagGone, expected: stored },
  "mknodat": { call: "mknodat", form: "where a file is", change: flagGone, expected: stored },
  "symlink": { call: "symlink", form: "where a file is", change: flagGone, expected: stored },
  "symlinkat": { call: "symlinkat", form: "where a file is", change: flagGone, expected: stored },
  "link": { call: "link", form: "where a file is", change: flagGone, expected: stored },
  "linkat": { call: "linkat", form: "where a file is", change: flagGone, expected: stored },
  "linkat-follow": { call: "linkat", form: "AT_SYMLINK_FOLLOW", change: x, expected: stored },
  "linkat-nofollow": {
    call: "linkat",
    form: "AT_SYMLINK_NOFOLLOW",
    change: x,
    expected: refused("linkat with AT_SYMLINK_NOFOLLOW")
  },
  "linkat-empty-path": { call: "linkat", form: "a link itself", change: x, expected: stored },
  "bind": { call: "bind", form: "a socket path where a file is", change: flagGone, expected: stored },
  "connect": { call: "connect", form: "a socket path not there", change: none, expected: stored },
  "unlink": { call: "unlink", form: "a name not there", change: none, expected: stored },
  "rmdir": { call: "rmdir", form: "a name not there", change: ["data/none", "/"], expected: stored },
  "unlinkat": { call: "unlinkat", form: "a name not there", change: none, expected: stored },
  "unlinkat-removedir": { call: "unlinkat", form: "AT_REMOVEDIR", change: ["data/none", "/"], expected: stored },
  "rename": { call: "rename", form: "a name not there", change: none, expected: stored },
  "renameat": { call: "renameat", form: "a name not there", change: none, expected: stored },
  "renameat2": { call: "renameat2", form: "a name not there", change: none, expected: stored },
  "exchange": { call: "renameat2", form: "RENAME_EXCHANGE of two files", change: bad("data/yb.txt"), expected: stored },
  "exchange-directories": {
    call: "renameat2",
    form: "RENAME_EXCHANGE of two directories",
    change: bad("data/db/x.txt"),
    expected: refused("renameat2 with RENAME_EXCHANGE of a directory")
  },
  "no-replace": { call: "renameat2", form: "RENAME_NOREPLACE where a file is", change: flagGone, expected: stored },
  "chmod": { call: "chmod", form: "a name not there", change: none, expected: stored },
  "chown": { call: "chown", form: "a name not there", change: none, expected: stored },
  "lchown": { call: "lchown", form: "a name not there", change: none, expected: stored },
  "utime": { call: "utime", form: "a name not there", change: none, expected: stored },
  "utimes": { call: "utimes", form: "a name not there", change: none, expected: stored },
  "futimesat": { call: "futimesat", form: "a name not there", change: none, expected: stored },
  "utimensat": { call: "utimensat", form: "a name not there", change: none, expected: stored },
  "utimensat-nofollow": { call: "utimensat", form: "AT_SYMLINK_NOFOLLOW", change: none, expected: stored },
  "utimensat-descriptor": { call: "utimensat", form: "a descriptor, no path", change: x, expected: stored },
  "truncate": { call: "truncate", form: "a name not there", change: none, expected: stored },
  "fchmodat": { call: "fchmodat", form: "a name not there", change: none, expected: stored },
  "fchmodat2": { call: "fchmodat2", form: "a name not there", change: none, expected: stored },
  "fchownat": { call: "fchownat", form: "a name not there", change: none, expected: stored },
  "setxattr": { call: "setxattr", form: "a name not there", change: none, expected: stored },
  "lsetxattr": { call: "lsetxattr", form: "a name not there", change: none, expected: stored },
  "removexattr": { call: "removexattr", form: "a name not there", change: none, expected: stored },
  "lremovexattr": { call: "lremovexattr", form: "a name not there", change: none, expected: stored },
  "setxattrat": { call: "setxattrat", form: "a name not there", change: none, expected: newer },
  "removexattrat": { call: "removexattrat", form: "a name not there", change: none, expected: newer },
  "file_setattr": { call: "file_setattr", form: "a name not there", change: none, expected: newer },
  "fchmod": { call: "fchmod", form: "a descriptor", change: x, expected: stored },
  "fchown": { call: "fchown", form: "a descriptor", change: x, expected: stored },
  "clone": { call: "clone", form: "a process that reads", change: x, expected: stored },
  "fork": { call: "fork", form: "a process that reads", change: x, expected: stored },
  "vfork": { call: "vfork", form: "a program that reads", change: x, expected: stored },
  "clone3": { call: "clone3", form: "a program that reads", change: x, expected: stored },
  "rt_sigaction": { call: "rt_sigaction", form: "a handler without SA_RESTART", change: x, expected: stored },
  "seccomp": {
    call: "seccomp",
    form: "a filter of the run's own",
    change: x,
    expected: { strace: stored, observe: { reason: "it filtered its own system calls" } }
  },
  "io_uring": {
    call: "io_uring_enter",
    form: "an open through io_uring",
    change: x,
    expected: { strace: stored, observe: refused("io_uring") }
  },
  "io_uring-sqpoll": {
    call: "io_uring_setup",
    form: "IORING_SETUP_SQPOLL",
    change: x,
    expected: { strace: stored, observe: refused("io_uring with a kernel thread of its own") }
  },
  "pidfd_open": { call: "pidfd_open", form: "a descriptor of a process", change: x, expected: stored },
  "mseal": { call: "mseal", form: "a call that names no file", change: x, expected: stored },
  "listns": { call: "listns", form: "a call that names no file", change: x, expected: stored },
  "rseq_slice_yield": { call: "rseq_slice_yield", form: "a call that names no file", change: x, expected: stored },
  "unknown-call": {
    call: "(472)",
    form: "a call numbered past the table",
    change: x,
    expected: refused("a system call it does not know, numbered 472")
  },
  "unshare-namespace": {
    call: "unshare",
    form: "CLONE_NEWUSER",
    change: x,
    expected: { strace: "either", observe: { reason: "it made a namespace of its own" } }
  },
  "mount-in-namespace": {
    call: "mount",
    form: "inside the step's own namespace",
    change: x,
    expected: { strace: "either", observe: { reason: "it made a namespace of its own" } }
  },
  "name_to_handle_at": {
    call: "name_to_handle_at",
    form: "a file's handle",
    change: x,
    expected: refused("name_to_handle_at")
  },
  "open_by_handle_at": {
    call: "open_by_handle_at",
    form: "a handle",
    change: x,
    expected: failsHere("open_by_handle_at")
  },
  "chroot": { call: "chroot", form: "another root", change: x, expected: failsHere("chroot") },
  "pivot_root": { call: "pivot_root", form: "another root", change: x, expected: failsHere("pivot_root") },
  "mount": { call: "mount", form: "a mount", change: x, expected: failsHere("mount") },
  "umount2": { call: "umount2", form: "a mount taken away", change: x, expected: failsHere("umount2") },
  "setns": { call: "setns", form: "another namespace", change: x, expected: failsHere("setns") },
  "open_tree": {
    call: "open_tree",
    form: "a mount by its path",
    change: x,
    expected: { strace: "either", observe: refused("open_tree") }
  },
  "move_mount": { call: "move_mount", form: "a mount moved", change: x, expected: failsHere("move_mount") },
  "fsopen": { call: "fsopen", form: "a file system", change: x, expected: failsHere("fsopen") },
  "fsconfig": { call: "fsconfig", form: "a file system", change: x, expected: failsHere("fsconfig") },
  "fsmount": { call: "fsmount", form: "a file system", change: x, expected: failsHere("fsmount") },
  "fspick": { call: "fspick", form: "a mount by its path", change: x, expected: failsHere("fspick") },
  "mount_setattr": {
    call: "mount_setattr",
    form: "a mount by its path",
    change: x,
    expected: failsHere("mount_setattr")
  },
  "open_tree_attr": {
    call: "open_tree_attr",
    form: "a mount by its path",
    change: x,
    expected: { strace: "either", observe: refused("open_tree_attr") }
  },
  "fanotify_mark": {
    call: "fanotify_mark",
    form: "a watch on a mount",
    change: x,
    expected: failsHere("fanotify_mark")
  },
  "quotactl": { call: "quotactl", form: "a device", change: x, expected: failsHere("quotactl") },
  "swapon": { call: "swapon", form: "a swap file", change: x, expected: failsHere("swapon") },
  "swapoff": { call: "swapoff", form: "a swap file", change: x, expected: failsHere("swapoff") },
  "acct": { call: "acct", form: "an accounting file", change: x, expected: failsHere("acct") },
  "uselib": { call: "uselib", form: "a library", change: x, expected: failsHere("uselib") },
  "bpf": { call: "bpf", form: "a pinned object", change: x, expected: failsHere("bpf") }
}

// The ways a directory reached each way is asked about.
for (const how of ["opath", "fchdir", "in-root", "dotdot"]) {
  const base = how === "dotdot" ? "data/sub/dir3" : "data/dir2"
  const by = {
    "opath": "an O_PATH descriptor",
    "fchdir": "fchdir",
    "in-root": "RESOLVE_IN_ROOT",
    "dotdot": "`..` through a link"
  }[how]!
  Object.assign(ways, {
    [`statx-in-a-directory-by-${how}`]: {
      call: "statx",
      form: `in a directory reached by ${by}`,
      change: bad(`${base}/s.txt`),
      expected: stored
    },
    [`faccessat2-in-a-directory-by-${how}`]: {
      call: "faccessat2",
      form: `in a directory reached by ${by}`,
      change: [`${base}/f`, undefined],
      expected: stored
    },
    [`readlinkat-in-a-directory-by-${how}`]: {
      call: "readlinkat",
      form: `in a directory reached by ${by}`,
      change: [`${base}/l`, "-> y"],
      expected: stored
    },
    [`getdents64-in-a-directory-by-${how}`]: {
      call: "getdents64",
      form: `of a directory reached by ${by}`,
      change: [`${base}/n`, "new\n"],
      expected: stored
    }
  })
}
