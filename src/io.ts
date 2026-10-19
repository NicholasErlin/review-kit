/** Output streams, swappable so tests can capture what a command prints (like contextlib.redirect_stdout). */
export const io = {
  stdout(text: string): void {
    process.stdout.write(text);
  },
  stderr(text: string): void {
    process.stderr.write(text);
  },
};

/** print(*args): space-joined, newline-terminated, to stdout. */
export function print(...args: unknown[]): void {
  io.stdout(args.map(String).join(' ') + '\n');
}

/** print(*args, file=sys.stderr) */
export function eprint(...args: unknown[]): void {
  io.stderr(args.map(String).join(' ') + '\n');
}
