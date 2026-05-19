#!/usr/bin/env python3
"""PTY wrapper — spawns a command in a pseudo-terminal, proxies I/O to parent.

Usage: pty-wrap.py [--] command [args...]

Gives the child a real TTY (so Claude CLI enters interactive mode) while
letting the Node process manager read/write via ordinary pipes.
"""
import sys, os, pty, select, signal, errno

def main():
    args = sys.argv[1:]
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        sys.exit("usage: pty-wrap.py [--] command [args...]")

    pid, fd = pty.fork()
    if pid == 0:
        # Child: exec the target command in the new PTY.
        os.execvp(args[0], args)

    # Parent: proxy I/O between our stdio and the PTY master fd.
    def handle_term(signum, frame):
        os.kill(pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, handle_term)
    signal.signal(signal.SIGINT, handle_term)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    try:
        while True:
            try:
                ready, _, _ = select.select([fd, stdin_fd], [], [], 1.0)
            except (select.error, ValueError):
                break

            if fd in ready:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    os.write(stdout_fd, data)
                except OSError as e:
                    if e.errno == errno.EIO:
                        break  # PTY closed
                    raise

            if stdin_fd in ready:
                try:
                    data = os.read(stdin_fd, 4096)
                    if not data:
                        break
                    os.write(fd, data)
                except OSError:
                    break
    except KeyboardInterrupt:
        os.kill(pid, signal.SIGTERM)

    _, status = os.waitpid(pid, 0)
    code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
    sys.exit(code)

if __name__ == "__main__":
    main()
