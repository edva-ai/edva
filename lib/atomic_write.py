"""atomic_write.py — replace a file so a reader sees the old content or the new,
never a half-written one. Python twin of lib/atomic-write.js (decision
D15, 2026-10-22); read that file's header for the why and the limits (not a
lock; not for .jsonl files other processes append to).

    sys.path.insert(0, os.path.join(REPO, "lib"))
    from atomic_write import write_text_atomic, write_json_atomic
    write_json_atomic(path, obj, indent=2)
"""

import json
import os
import tempfile


def write_text_atomic(path, text, *, mode=None, fsync=True, encoding="utf-8"):
    target = os.path.realpath(os.path.expanduser(path))
    d = os.path.dirname(target) or "."
    os.makedirs(d, exist_ok=True)
    if mode is None:
        try:
            mode = os.stat(target).st_mode & 0o7777
        except FileNotFoundError:
            mode = None
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(target) + ".tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            f.write(text)
            f.flush()
            if fsync:
                os.fsync(f.fileno())
        # mkstemp creates 0600; keep the old file's mode, or the umask default.
        if mode is None:
            umask = os.umask(0)
            os.umask(umask)
            mode = 0o666 & ~umask
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if fsync:
        try:
            dfd = os.open(d, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass


def write_json_atomic(path, obj, *, indent=None, ensure_ascii=True, newline=False, **kw):
    text = json.dumps(obj, indent=indent, ensure_ascii=ensure_ascii)
    write_text_atomic(path, text + ("\n" if newline else ""), **kw)
