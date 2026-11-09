#!/usr/bin/env python3
"""Run one test command with owned PTY stdin, capturing output and preserving its exit status."""

import errno
import os
import pty
import selectors
import signal
import stat
import subprocess
import sys
import tty

if len(sys.argv) < 2:
    raise SystemExit("usage: pty-driver.py COMMAND [ARG ...]")

master, slave = pty.openpty()
tty.setraw(slave)
child = subprocess.Popen(
    sys.argv[1:], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, start_new_session=True
)
os.close(slave)


def stop_child(signum, _frame):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, stop_child)
signal.signal(signal.SIGINT, stop_child)
selector = selectors.DefaultSelector()
selector.register(master, selectors.EVENT_READ, "pty")
selector.register(child.stdout, selectors.EVENT_READ, "stdout")
selector.register(child.stderr, selectors.EVENT_READ, "stderr")
stdin_mode = os.fstat(sys.stdin.fileno()).st_mode
stdin_registered = stat.S_ISFIFO(stdin_mode) or stat.S_ISSOCK(stdin_mode)
if stdin_registered:
    selector.register(sys.stdin.buffer, selectors.EVENT_READ, "stdin")

while selector.get_map():
    for key, _ in selector.select(timeout=0.1):
        try:
            data = os.read(key.fd, 65536)
        except OSError as error:
            if key.data == "pty" and error.errno == errno.EIO:
                data = b""
            else:
                raise
        if not data:
            selector.unregister(key.fileobj)
            if key.data == "pty":
                os.close(master)
            elif key.data == "stdin":
                stdin_registered = False
            else:
                key.fileobj.close()
        elif key.data == "stdin":
            view = memoryview(data)
            while view:
                written = os.write(master, view)
                view = view[written:]
        elif key.data == "stdout":
            sys.stdout.buffer.write(data)
            sys.stdout.flush()
        elif key.data == "stderr":
            sys.stderr.buffer.write(data)
            sys.stderr.flush()
    if child.poll() is not None and stdin_registered:
        selector.unregister(sys.stdin.buffer)
        stdin_registered = False

status = child.wait()
raise SystemExit(status if status >= 0 else 128 - status)
