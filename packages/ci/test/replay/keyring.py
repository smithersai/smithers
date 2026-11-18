"""The kernel's keyring of this session, for Reach.test.ts.

plant: adds a key. look: searches for it and reads it. drop: removes it. Prints what happened, never the key.
"""
import ctypes
import platform
import sys

libc = ctypes.CDLL(None, use_errno=True)
# add_key and keyctl, by processor.
ADD_KEY, KEYCTL = {"x86_64": (248, 250), "aarch64": (217, 219)}.get(platform.machine(), (217, 219))
SESSION = -3
SEARCH, READ, UNLINK = 10, 11, 9
NAME = b"smithers-ci-reach-test"
VALUE = b"a key of the session"


def find():
    return libc.syscall(KEYCTL, SEARCH, SESSION, b"user", NAME, 0)


if sys.argv[1] == "plant":
    added = libc.syscall(ADD_KEY, b"user", NAME, VALUE, len(VALUE), SESSION)
    print("planted" if added >= 0 else "not planted %d" % ctypes.get_errno())
elif sys.argv[1] == "drop":
    key = find()
    if key >= 0:
        libc.syscall(KEYCTL, UNLINK, key, SESSION)
    print("dropped")
else:
    key = find()
    if key < 0:
        print("session: refused %d" % ctypes.get_errno())
    else:
        held = ctypes.create_string_buffer(64)
        size = libc.syscall(KEYCTL, READ, key, held, 64)
        print("session: read" if held.raw[:max(size, 0)] == VALUE else "session: found, not read %d" % ctypes.get_errno())
