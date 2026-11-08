"""Publish a prepared directory atomically, refusing even an empty destination.

Node's rename replaces an empty legacy mkdir lock. Python's standard-library
FFI exposes the exclusive rename flags without an install or native build.
Unsupported hosts/filesystems fail closed; never substitute ordinary rename.
"""
import ctypes
import errno
import os
import sys

libc = ctypes.CDLL(None, use_errno=True)
source, destination = map(os.fsencode, sys.argv[1:])
if sys.platform == "darwin":
    # apple-oss-distributions/xnu, bsd/sys/stdio.h: RENAME_EXCL
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    arguments = [source, destination, 4]
elif sys.platform == "linux" and hasattr(libc, "renameat2"):
    # torvalds/linux, include/uapi/linux/fs.h: RENAME_NOREPLACE; AT_FDCWD=-100
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    arguments = [-100, source, -100, destination, 1]
else:
    sys.exit("Atomic exclusive directory rename requires macOS or Linux libc renameat2")
rename.restype = ctypes.c_int
if rename(*arguments) == 0:
    sys.exit(0)
failure = ctypes.get_errno()
if failure == errno.EEXIST:
    sys.exit(17)
sys.exit("Atomic exclusive directory rename failed: " + os.strerror(failure))
