/**
 * Every system call that names a file, and how a recorded run takes it: the
 * one table `smthrs-observe` (through `native/calls.h`, which
 * `scripts/build-observe.mjs` writes from it), strace's list of calls, and the
 * reader of both recorders' lines are built from.
 *
 * A row says where the call's arguments are and which of its flags the
 * recorder follows exactly. A run stores nothing, and says why
 * ({@link cannotFollow}), when it makes a call whose row is `refused`, gives a
 * call a flag its row does not name, or makes a call numbered past
 * {@link lastKnown}, which this table cannot say anything about. The calls are
 * those of Linux 7.0 (`arch/x86/entry/syscalls/syscall_64.tbl` and
 * `include/uapi/asm-generic/unistd.h`); a call this table leaves out takes no
 * path.
 *
 * This file is read by Node with its types stripped, so it holds plain data
 * and imports nothing.
 *
 * @since 1.0.0
 */

/**
 * How a recorder takes a call:
 *
 * - `open`: opens a path; its flags say whether it reads, writes or makes it.
 * - `look`: learns whether a path is there, and what it is.
 * - `exec`: starts the program at a path.
 * - `chdir`, `fchdir`: moves the working directory.
 * - `list`: lists a directory by its descriptor.
 * - `descriptor`: makes a descriptor name what another names: strace prints both, and its reader keeps what each
 *   descriptor names, for a path below one (`/dev/fd/4/x`).
 * - `mkdir`, `make`: makes a directory, or another name where none was.
 * - `remove`: takes a name away.
 * - `change`, `changeFd`: changes a file's mode, owner, times, size or attributes, by path or by descriptor.
 * - `rename`, `link`, `symlink`: moves a name, adds a name, makes a link.
 * - `connect`, `bind`: reaches or offers a socket, which may be a path.
 * - `send`: sends to the address it names (`sendto`, `sendmsg`, `sendmmsg`), which reaches what is there as `connect`
 *   does; one that names no address sends where its socket is already connected.
 * - `fork`, `space`: starts a process or a thread, or gives one namespaces or a working directory of its own.
 * - `ring`: sets up an io_uring. The kernel takes a ring's requests from memory the run shares with it, where no
 *   recorder reads them as the kernel takes them, so both recorders answer it `ENOSYS`, as a container's default
 *   filter does, and a program falls back to the calls a trace shows.
 * - `ringEnter`: drives or changes a ring, which then can only have come from outside the run: it stores nothing.
 * - `filter`, `handler`: filters the run's own calls; sets a signal handler.
 * - `none`: names no file (a call numbered past the oldest strace's table, which prints it by number).
 * - `refused`: names a file in a way no record can hold: a run that makes it stores nothing.
 *
 * @category calls
 * @since 1.0.0
 */
export type Kind =
  | "open"
  | "look"
  | "exec"
  | "chdir"
  | "fchdir"
  | "list"
  | "descriptor"
  | "mkdir"
  | "make"
  | "remove"
  | "change"
  | "changeFd"
  | "rename"
  | "link"
  | "symlink"
  | "connect"
  | "bind"
  | "send"
  | "fork"
  | "space"
  | "ring"
  | "ringEnter"
  | "filter"
  | "handler"
  | "none"
  | "refused"

/** Where a call's working directory argument is: the thread's working directory.
 *
 * @category calls
 * @since 1.0.0
 */
export const cwd = -1

/**
 * One call. `dir` and `path` are argument indexes (`dir` {@link cwd}: the working directory); `dir2` and `path2`
 * likewise for a second path; `flags` the index of the flags whose names `follows` lists.
 *
 * @category calls
 * @since 1.0.0
 */
export interface Call {
  readonly name: string
  readonly kind: Kind
  /** Its number, for a call numbered alike on every machine (424 on); any other has its machine's own. */
  readonly number?: number
  readonly dir?: number
  readonly path?: number
  readonly dir2?: number
  readonly path2?: number
  readonly flags?: number
  /** The flags of `flags` followed exactly, by the names strace prints; `0` is always followed. */
  readonly follows?: ReadonlyArray<string>
  /** The call does not follow a link at the end of its path. */
  readonly nofollow?: true
  /** The one recorder that watches it: the other needs nothing of it. */
  readonly only?: "strace" | "smthrs-observe"
}

/** The calls past which this table says nothing: Linux 7.0's last is `rseq_slice_yield`, 471.
 *
 * @category calls
 * @since 1.0.0
 */
export const lastKnown = 471

/** The value of each flag a row may name, on x86_64 and on aarch64 where they differ.
 *
 * @category calls
 * @since 1.0.0
 */
export const flagValues: { readonly [name: string]: number | readonly [x86_64: number, aarch64: number] } = {
  O_RDONLY: 0,
  O_WRONLY: 0x1,
  O_RDWR: 0x2,
  O_ACCMODE: 0x3,
  O_CREAT: 0x40,
  O_EXCL: 0x80,
  O_NOCTTY: 0x100,
  O_TRUNC: 0x200,
  O_APPEND: 0x400,
  O_NONBLOCK: 0x800,
  O_DSYNC: 0x1000,
  FASYNC: 0x2000,
  O_DIRECT: [0x4000, 0x10000],
  O_LARGEFILE: [0x8000, 0x20000],
  O_DIRECTORY: [0x10000, 0x4000],
  O_NOFOLLOW: [0x20000, 0x8000],
  O_NOATIME: 0x40000,
  O_CLOEXEC: 0x80000,
  __O_SYNC: 0x100000,
  O_SYNC: 0x101000,
  O_PATH: 0x200000,
  __O_TMPFILE: 0x400000,
  O_TMPFILE: [0x410000, 0x404000],
  AT_SYMLINK_NOFOLLOW: 0x100,
  AT_EACCESS: 0x200,
  AT_REMOVEDIR: 0x200,
  AT_SYMLINK_FOLLOW: 0x400,
  AT_NO_AUTOMOUNT: 0x800,
  AT_EMPTY_PATH: 0x1000,
  AT_STATX_SYNC_AS_STAT: 0,
  AT_STATX_FORCE_SYNC: 0x2000,
  AT_STATX_DONT_SYNC: 0x4000,
  RENAME_NOREPLACE: 0x1,
  RENAME_EXCHANGE: 0x2,
  RENAME_WHITEOUT: 0x4,
  RESOLVE_NO_XDEV: 0x01,
  RESOLVE_NO_MAGICLINKS: 0x02,
  RESOLVE_NO_SYMLINKS: 0x04,
  RESOLVE_BENEATH: 0x08,
  RESOLVE_IN_ROOT: 0x10,
  RESOLVE_CACHED: 0x20
}

/**
 * The flags of an open the recorder follows: every one the kernel has today. Those that change what a path names
 * (`O_NOFOLLOW`, `O_DIRECTORY`, `O_PATH`, `O_CREAT`, `O_EXCL`, `O_TRUNC`, `O_TMPFILE`) are read; the others change
 * how the file is used, not which file it is.
 *
 * @category calls
 * @since 1.0.0
 */
export const openFlags: ReadonlyArray<string> = [
  "O_RDONLY",
  "O_WRONLY",
  "O_RDWR",
  "O_ACCMODE",
  "O_CREAT",
  "O_EXCL",
  "O_NOCTTY",
  "O_TRUNC",
  "O_APPEND",
  "O_NONBLOCK",
  "O_DSYNC",
  "FASYNC",
  "O_DIRECT",
  "O_LARGEFILE",
  "O_DIRECTORY",
  "O_NOFOLLOW",
  "O_NOATIME",
  "O_CLOEXEC",
  "__O_SYNC",
  "O_SYNC",
  "O_PATH",
  "__O_TMPFILE",
  "O_TMPFILE"
]

/** The `RESOLVE_*` flags of `openat2` a walk follows exactly.
 *
 * @category calls
 * @since 1.0.0
 */
export const resolveFlags: ReadonlyArray<string> = [
  "RESOLVE_NO_XDEV",
  "RESOLVE_NO_MAGICLINKS",
  "RESOLVE_NO_SYMLINKS",
  "RESOLVE_BENEATH",
  "RESOLVE_IN_ROOT",
  "RESOLVE_CACHED"
]

const nofollowEmpty = ["AT_SYMLINK_NOFOLLOW", "AT_EMPTY_PATH"]

/** The table.
 *
 * @category calls
 * @since 1.0.0
 */
export const calls: ReadonlyArray<Call> = [
  // Opens.
  { name: "open", kind: "open", dir: cwd, path: 0, flags: 1, follows: openFlags },
  { name: "openat", kind: "open", dir: 0, path: 1, flags: 2, follows: openFlags },
  { name: "openat2", kind: "open", number: 437, dir: 0, path: 1 },
  { name: "creat", kind: "open", dir: cwd, path: 0 },
  // Lookups.
  { name: "stat", kind: "look", dir: cwd, path: 0 },
  { name: "lstat", kind: "look", dir: cwd, path: 0, nofollow: true },
  {
    name: "newfstatat",
    kind: "look",
    dir: 0,
    path: 1,
    flags: 3,
    follows: [...nofollowEmpty, "AT_NO_AUTOMOUNT"]
  },
  {
    name: "statx",
    kind: "look",
    dir: 0,
    path: 1,
    flags: 2,
    follows: [...nofollowEmpty, "AT_NO_AUTOMOUNT", "AT_STATX_SYNC_AS_STAT", "AT_STATX_FORCE_SYNC", "AT_STATX_DONT_SYNC"]
  },
  { name: "access", kind: "look", dir: cwd, path: 0 },
  { name: "faccessat", kind: "look", dir: 0, path: 1 },
  {
    name: "faccessat2",
    kind: "look",
    number: 439,
    dir: 0,
    path: 1,
    flags: 3,
    follows: ["AT_EACCESS", ...nofollowEmpty]
  },
  { name: "readlink", kind: "look", dir: cwd, path: 0, nofollow: true },
  { name: "readlinkat", kind: "look", dir: 0, path: 1, nofollow: true },
  // A file system's numbers, a file's extended attributes, a watch: each learns of the path, not what it holds.
  { name: "statfs", kind: "look", dir: cwd, path: 0 },
  { name: "getxattr", kind: "look", dir: cwd, path: 0 },
  { name: "lgetxattr", kind: "look", dir: cwd, path: 0, nofollow: true },
  { name: "listxattr", kind: "look", dir: cwd, path: 0 },
  { name: "llistxattr", kind: "look", dir: cwd, path: 0, nofollow: true },
  { name: "getxattrat", kind: "look", number: 464, dir: 0, path: 1, flags: 2, follows: nofollowEmpty },
  { name: "listxattrat", kind: "look", number: 465, dir: 0, path: 1, flags: 2, follows: nofollowEmpty },
  { name: "file_getattr", kind: "look", number: 468, dir: 0, path: 1, flags: 4, follows: nofollowEmpty },
  { name: "inotify_add_watch", kind: "look", dir: cwd, path: 1 },
  // Programs.
  { name: "execve", kind: "exec", dir: cwd, path: 0 },
  { name: "execveat", kind: "exec", dir: 0, path: 1, flags: 4, follows: nofollowEmpty },
  // The working directory, and listings.
  { name: "chdir", kind: "chdir", dir: cwd, path: 0 },
  // smthrs-observe reads each call's working directory from the kernel at the call; strace's reader follows it.
  { name: "fchdir", kind: "fchdir", dir: 0 },
  // smthrs-observe lists a directory where it is opened.
  { name: "getdents", kind: "list", dir: 0, only: "strace" },
  { name: "getdents64", kind: "list", dir: 0, only: "strace" },
  // smthrs-observe reads where a descriptor leads from the kernel at each call.
  { name: "dup", kind: "descriptor", only: "strace" },
  { name: "dup2", kind: "descriptor", only: "strace" },
  { name: "dup3", kind: "descriptor", only: "strace" },
  // strace refuses a pidfd (`ENOSYS`), so a parent waits for its child as on a kernel without pidfds: it reaps a
  // traced process before the parent could, and the pidfd would say it ended when it had not.
  { name: "pidfd_open", kind: "descriptor", number: 434, only: "strace" },
  // Names made and taken away.
  { name: "mkdir", kind: "mkdir", dir: cwd, path: 0, nofollow: true },
  { name: "mkdirat", kind: "mkdir", dir: 0, path: 1, nofollow: true },
  { name: "mknod", kind: "make", dir: cwd, path: 0, nofollow: true },
  { name: "mknodat", kind: "make", dir: 0, path: 1, nofollow: true },
  { name: "unlink", kind: "remove", dir: cwd, path: 0, nofollow: true },
  { name: "rmdir", kind: "remove", dir: cwd, path: 0, nofollow: true },
  { name: "unlinkat", kind: "remove", dir: 0, path: 1, flags: 2, follows: ["AT_REMOVEDIR"], nofollow: true },
  // Changes to a file in place.
  { name: "chmod", kind: "change", dir: cwd, path: 0 },
  { name: "chown", kind: "change", dir: cwd, path: 0 },
  { name: "lchown", kind: "change", dir: cwd, path: 0, nofollow: true },
  { name: "utime", kind: "change", dir: cwd, path: 0 },
  { name: "utimes", kind: "change", dir: cwd, path: 0 },
  { name: "futimesat", kind: "change", dir: 0, path: 1 },
  { name: "utimensat", kind: "change", dir: 0, path: 1, flags: 3, follows: nofollowEmpty },
  { name: "truncate", kind: "change", dir: cwd, path: 0 },
  { name: "fchmodat", kind: "change", dir: 0, path: 1 },
  { name: "fchmodat2", kind: "change", number: 452, dir: 0, path: 1, flags: 3, follows: nofollowEmpty },
  { name: "fchownat", kind: "change", dir: 0, path: 1, flags: 4, follows: nofollowEmpty },
  { name: "setxattr", kind: "change", dir: cwd, path: 0 },
  { name: "lsetxattr", kind: "change", dir: cwd, path: 0, nofollow: true },
  { name: "removexattr", kind: "change", dir: cwd, path: 0 },
  { name: "lremovexattr", kind: "change", dir: cwd, path: 0, nofollow: true },
  { name: "setxattrat", kind: "change", number: 463, dir: 0, path: 1, flags: 2, follows: nofollowEmpty },
  { name: "removexattrat", kind: "change", number: 466, dir: 0, path: 1, flags: 2, follows: nofollowEmpty },
  { name: "file_setattr", kind: "change", number: 469, dir: 0, path: 1, flags: 4, follows: nofollowEmpty },
  { name: "fchmod", kind: "changeFd", dir: 0 },
  { name: "fchown", kind: "changeFd", dir: 0 },
  // Names moved, added and linked.
  { name: "rename", kind: "rename", dir: cwd, path: 0, dir2: cwd, path2: 1, nofollow: true },
  { name: "renameat", kind: "rename", dir: 0, path: 1, dir2: 2, path2: 3, nofollow: true },
  {
    name: "renameat2",
    kind: "rename",
    dir: 0,
    path: 1,
    dir2: 2,
    path2: 3,
    flags: 4,
    follows: ["RENAME_NOREPLACE", "RENAME_EXCHANGE", "RENAME_WHITEOUT"],
    nofollow: true
  },
  { name: "link", kind: "link", dir: cwd, path: 0, dir2: cwd, path2: 1, nofollow: true },
  {
    name: "linkat",
    kind: "link",
    dir: 0,
    path: 1,
    dir2: 2,
    path2: 3,
    flags: 4,
    follows: ["AT_SYMLINK_FOLLOW", "AT_EMPTY_PATH"],
    nofollow: true
  },
  { name: "symlink", kind: "symlink", dir2: cwd, path2: 1, nofollow: true },
  { name: "symlinkat", kind: "symlink", dir2: 1, path2: 2, nofollow: true },
  // Sockets, which a path can name.
  { name: "connect", kind: "connect" },
  { name: "bind", kind: "bind" },
  { name: "sendto", kind: "send" },
  { name: "sendmsg", kind: "send" },
  { name: "sendmmsg", kind: "send" },
  // Processes, threads and namespaces.
  { name: "clone", kind: "fork" },
  { name: "clone3", kind: "fork", number: 435 },
  { name: "fork", kind: "fork" },
  { name: "vfork", kind: "fork" },
  { name: "unshare", kind: "space" },
  // io_uring: refused to every run, so programs fall back to calls a trace shows (libuv, and so node, sets up rings
  // at every start, and runs on without them).
  { name: "io_uring_setup", kind: "ring", number: 425 },
  { name: "io_uring_enter", kind: "ringEnter", number: 426 },
  { name: "io_uring_register", kind: "ringEnter", number: 427 },
  { name: "seccomp", kind: "filter", only: "smthrs-observe" },
  { name: "rt_sigaction", kind: "handler", only: "smthrs-observe" },
  // Calls numbered past what strace 6.8 knows, which take no path.
  { name: "mseal", kind: "none", number: 462, only: "strace" },
  { name: "listns", kind: "none", number: 470, only: "strace" },
  { name: "rseq_slice_yield", kind: "none", number: 471, only: "strace" },
  // Calls that name a file no record can hold: by a handle instead of a path, through another root or another
  // set of mounts, as a device, a swap area or an accounting file, or as a pinned kernel object.
  { name: "open_by_handle_at", kind: "refused" },
  { name: "name_to_handle_at", kind: "refused" },
  { name: "chroot", kind: "refused" },
  { name: "pivot_root", kind: "refused" },
  { name: "mount", kind: "refused" },
  { name: "umount2", kind: "refused" },
  { name: "setns", kind: "refused" },
  { name: "open_tree", kind: "refused", number: 428 },
  { name: "move_mount", kind: "refused", number: 429 },
  { name: "fsopen", kind: "refused", number: 430 },
  { name: "fsconfig", kind: "refused", number: 431 },
  { name: "fsmount", kind: "refused", number: 432 },
  { name: "fspick", kind: "refused", number: 433 },
  { name: "mount_setattr", kind: "refused", number: 442 },
  { name: "open_tree_attr", kind: "refused", number: 467 },
  { name: "fanotify_mark", kind: "refused" },
  { name: "quotactl", kind: "refused" },
  { name: "swapon", kind: "refused" },
  { name: "swapoff", kind: "refused" },
  { name: "acct", kind: "refused" },
  { name: "uselib", kind: "refused" },
  { name: "bpf", kind: "refused" }
]

/**
 * Why a run stores nothing when it reached a file in a way the recorder does
 * not follow exactly: `form` names the call, and the flag or form of it.
 *
 * @category calls
 * @since 1.0.0
 */
export const cannotFollow = (form: string): string => `it reached a file in a way the recorder cannot follow: ${form}`

/**
 * Why a run that used an io_uring stores nothing: `call` is the call that set it up or drove it. No run sets one up
 * (both recorders answer `io_uring_setup` with `ENOSYS`), so a ring is one the run was given.
 *
 * @category calls
 * @since 1.0.0
 */
export const ringUsed = (call: string): string =>
  `it used an io_uring (${call}), whose requests the kernel reads from memory the step can change after any recorder looked`

/** Each call by its name.
 *
 * @category calls
 * @since 1.0.0
 */
export const byName: ReadonlyMap<string, Call> = new Map(calls.map((call) => [call.name, call]))

/** Each call numbered alike on every machine, by its number.
 *
 * @category calls
 * @since 1.0.0
 */
export const byNumber: ReadonlyMap<number, Call> = new Map(
  calls.flatMap((call) => call.number === undefined ? [] : [[call.number, call] as const])
)

/**
 * Why a call's flags are not followed exactly, as strace prints them: the
 * first name its row does not list (strace prints a bit it has no name for as
 * `0x8000 /* AT_??? *\/`); `undefined` when every one is followed.
 *
 * @category calls
 * @since 1.0.0
 */
export const unfollowed = (call: Call, text: string): string | undefined => {
  if (call.follows === undefined) return undefined
  let known = answered.get(call)
  if (known === undefined) answered.set(call, known = new Map())
  // A trace repeats a few spellings of a call's flags hundreds of thousands of times: each is answered once.
  if (known.has(text)) return known.get(text)
  const names = new Set(["0", ...call.follows])
  let answer: string | undefined
  for (const part of text.split("|")) {
    const flag = part.replace(/\/\*.*\*\//s, "").trim()
    if (!names.has(flag)) {
      answer = `${call.name} with ${flag}`
      break
    }
  }
  if (known.size < 4096) known.set(text, answer)
  return answer
}

/** What each row answered for each spelling of its flags. */
const answered = new WeakMap<Call, Map<string, string | undefined>>()

/** The calls strace is told to trace: every row it watches, each it may not know by name marked so (`?`).
 *
 * @category calls
 * @since 1.0.0
 */
export const traced: ReadonlyArray<string> = calls
  .filter((call) => call.only !== "smthrs-observe" && call.kind !== "none")
  .map((call) => `?${call.name}`)
