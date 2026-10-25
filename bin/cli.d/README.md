# cli.d — an installation's own `edva` subcommands

`bin/edva` loads every `bin/cli.d/<name>.mjs` here (files
starting with `_` are skipped) and offers it as `edva <name>`, after its
built-in subcommands. A built-in name always wins; a module that fails to load
is reported on stderr and skipped, never fatal to the CLI. `edva help`
lists the loaded ones under **EXTENSIONS**.

## Contract

Each module default-exports one object:

```js
export default {
  name: "hello",                 // optional; default: the file name without .mjs
  summary: "say hello",          // one line for `edva help`
  usage: "hello [--loud]",       // optional; default: the name
  async run(args, ctx) {         // args: the words after the subcommand
    ctx.die("…");                // ctx: { ROOT, TOOLS, HOME, OWNER, c, table, hasFlag, getFlag, die }
  },
};
```

- `ROOT` is the installation (`~/Dev/edva`), `TOOLS` its kernel tree;
  `c` holds the colour helpers, `table(rows, headers)` the table printer,
  `hasFlag` / `getFlag` the flag readers, `die(msg, code)` the error exit.
- A thrown error is printed as `Error: <subcommand>: <message>` with exit 1.
- Keep a subcommand's own logic in its module (or in a bin it calls); the CLI
  only dispatches.

## Classification

This directory's modules belong to the installation, not to the kernel: a new
one is classified in `system/kernel-manifest.json` like any other file
(`personal_globs` for this installation's own). Edva tracks its own
subcommands here (`init`, `overlay`, `up`, `review-pr`, `telemetry`); the
Edva sync copies only this README.
