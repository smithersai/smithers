"""A private PTY: JSON input bytes in, base64 terminal output out. No shell."""
import base64, fcntl, json, os, pty, select, signal, struct, sys, termios, time
config = json.loads(sys.stdin.readline())
pid, fd = pty.fork()
if pid == 0:
    os.chdir(config['cwd'])
    os.execvpe(config['argv'][0], config['argv'], config['env'])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 28, 100, 0, 0))
def terminate(_signal, _frame):
    raise SystemExit()
signal.signal(signal.SIGTERM, terminate)
buffer = b''
try:
    while True:
        ready, _, _ = select.select([fd, sys.stdin], [], [], 1)
        if fd in ready:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            print(json.dumps({'data': base64.b64encode(data).decode()}), flush=True)
        if sys.stdin in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data: break
            buffer += data
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                os.write(fd, base64.b64decode(json.loads(line)['input']))
finally:
    # A second signal must not interrupt reaping the PTY's process group.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    os.close(fd)
    deadline = time.monotonic() + 2
    while os.waitpid(pid, os.WNOHANG)[0] == 0:
        if time.monotonic() > deadline:
            try: os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            os.waitpid(pid, 0)
            break
        time.sleep(0.05)
