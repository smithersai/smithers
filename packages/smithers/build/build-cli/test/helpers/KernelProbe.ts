/**
 * A program that reaches a file through one way of the kernel's, for the
 * tests of what a recorder writes down: `python3 probe.py <way>` reads what
 * that way leads to and exits 0 when it reads `ok`, 1 otherwise, and 2 when
 * the call itself fails. Each way names the file whose change it must see in
 * {@link changes}.
 *
 * The calls Python has no function for are made by number; the numbers are
 * the kernel's for x86_64 and aarch64 (`arch/x86/entry/syscalls/syscall_64.tbl`
 * and `include/uapi/asm-generic/unistd.h`).
 */

/** The program, to be written to a file and run by `python3`. */
export const program = String.raw`
import ctypes, os, platform, struct, sys

libc = ctypes.CDLL(None, use_errno=True)
x86 = platform.machine() == "x86_64"
SYS_openat2 = 437
SYS_renameat2 = 316 if x86 else 276
AT_FDCWD = -100
RESOLVE_NO_XDEV, RESOLVE_NO_MAGICLINKS, RESOLVE_NO_SYMLINKS = 0x01, 0x02, 0x04
RESOLVE_BENEATH, RESOLVE_IN_ROOT, RESOLVE_CACHED = 0x08, 0x10, 0x20
RENAME_NOREPLACE, RENAME_EXCHANGE = 1, 2


def failed(what):
    print(what, os.strerror(ctypes.get_errno()))
    sys.exit(2)


def verdict(text):
    sys.exit(0 if text.strip() == "ok" else 1)


def contents(fd):
    data = b""
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            return data.decode()
        data += chunk


def openat2(dirfd, path, resolve, flags=os.O_RDONLY):
    how = ctypes.create_string_buffer(struct.pack("QQQ", flags, 0, resolve))
    fd = libc.syscall(SYS_openat2, ctypes.c_int(dirfd), ctypes.c_char_p(path.encode()), how, ctypes.c_size_t(24))
    if fd < 0:
        failed("openat2 " + path)
    return fd


def renameat2(old, new, flags):
    return libc.syscall(SYS_renameat2, AT_FDCWD, ctypes.c_char_p(old.encode()), AT_FDCWD, ctypes.c_char_p(new.encode()), ctypes.c_uint(flags))


def link(path, target):
    if not os.path.lexists(path):
        os.symlink(target, path)


root = lambda: os.open("data/root", os.O_RDONLY | os.O_DIRECTORY)
way = sys.argv[1]
if way == "in-root":  # "/x.txt" inside data/root is data/root/x.txt, not the machine's /x.txt
    verdict(contents(openat2(root(), "/x.txt", RESOLVE_IN_ROOT)))
if way == "in-root-up":  # ".." at the root stays there
    verdict(contents(openat2(root(), "../../x.txt", RESOLVE_IN_ROOT)))
if way == "in-root-link":  # a link the step makes to "/sub/y.txt" leads to data/root/sub/y.txt
    link("data/root/abs", "/sub/y.txt")
    verdict(contents(openat2(root(), "abs", RESOLVE_IN_ROOT)))
if way == "in-root-committed-link":  # sub/back -> ../../../x.txt goes up past the root, so it stays there
    verdict(contents(openat2(root(), "sub/back", RESOLVE_IN_ROOT)))
if way == "beneath":
    verdict(contents(openat2(root(), "sub/y.txt", RESOLVE_BENEATH)))
if way == "no-symlinks":
    verdict(contents(openat2(root(), "x.txt", RESOLVE_NO_SYMLINKS)))
if way == "exchange":  # two files of the repository swapped, the first read, and swapped back
    if renameat2("data/ya.txt", "data/yb.txt", RENAME_EXCHANGE) != 0:
        failed("renameat2")
    text = open("data/ya.txt").read()
    renameat2("data/ya.txt", "data/yb.txt", RENAME_EXCHANGE)
    verdict(text)
if way == "no-replace":  # the move fails where data/flag is: the step learns that it is
    os.makedirs("build", exist_ok=True)
    open("build/new", "w").close()
    if renameat2("build/new", "data/flag", RENAME_NOREPLACE) == 0:
        os.rename("data/flag", "build/new")
        sys.exit(1)
    sys.exit(0)
if way == "exchange-directories":  # two directories swapped: what is below one was below the other
    if renameat2("data/da", "data/db", RENAME_EXCHANGE) != 0:
        failed("renameat2")
    text = open("data/da/x.txt").read()
    renameat2("data/da", "data/db", RENAME_EXCHANGE)
    verdict(text)
print("no such way", way)
sys.exit(2)
`

/** The repository a probe reads: each path with what it holds while every way reads `ok`. A link is `-> target`. */
export const files: ReadonlyArray<readonly [path: string, text: string]> = [
  ["data/root/x.txt", "ok\n"],
  ["data/root/sub/y.txt", "ok\n"],
  ["data/root/sub/back", "-> ../../../x.txt"],
  ["data/ya.txt", "zz\n"],
  ["data/yb.txt", "ok\n"],
  ["data/flag", "here\n"],
  ["data/da/x.txt", "zz\n"],
  ["data/db/x.txt", "ok\n"]
]

/**
 * What changes for each way, as a commit would change it: the path, and what it then holds (`undefined`: removed).
 * After it, the probe reads something other than `ok`, or finds what it did not before, and exits 1.
 */
export const changes: { readonly [way: string]: readonly [path: string, text: string | undefined] } = {
  "in-root": ["data/root/x.txt", "bad!\n"],
  "in-root-up": ["data/root/x.txt", "bad!\n"],
  "in-root-link": ["data/root/sub/y.txt", "bad!\n"],
  "in-root-committed-link": ["data/root/x.txt", "bad!\n"],
  "beneath": ["data/root/sub/y.txt", "bad!\n"],
  "no-symlinks": ["data/root/x.txt", "bad!\n"],
  "exchange": ["data/yb.txt", "bad!\n"],
  "no-replace": ["data/flag", undefined],
  "exchange-directories": ["data/db/x.txt", "bad!\n"]
}
