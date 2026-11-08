#!/usr/bin/env python3
"""Run one test command with owned PTY stdin, capturing output and preserving its exit status."""

import errno
import os
import pty
import selectors
import signal
import subprocess
import sys

if len(sys.argv) < 2:
    raise SystemExit("usage: pty-driver.py COMMAND [ARG ...]")

master, slave = pty.openpty()
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
outputs = {"stdout": bytearray(), "stderr": bytearray()}

while selector.get_map():
    for key, _ in selector.select():
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
            else:
                key.fileobj.close()
        elif key.data != "pty":
            outputs[key.data].extend(data)

status = child.wait()
sys.stdout.buffer.write(outputs["stdout"])
sys.stderr.buffer.write(outputs["stderr"])
sys.stdout.flush()
sys.stderr.flush()
raise SystemExit(status if status >= 0 else 128 - status)
