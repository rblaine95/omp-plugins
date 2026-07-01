# AGENTS.md

**omp-plugins** — personal [oh-my-pi](https://github.com/can1357/oh-my-pi)
extensions, published as one installable plugin. Install/update/uninstall live in
[`README.md`](./README.md); this file is for _changing_ the code.

The repo root is the plugin manifest: root `package.json` `omp.extensions` lists every
entry point, so one install pulls the whole suite. Each extension is a Bun workspace
member under `extensions/*`. TypeScript run directly by [Bun](https://bun.com/docs/llms.txt)
(1.x, Node 24) — **no build step**.

## Layout

```text
package.json           root manifest; omp.extensions array = the install contract
extensions/<name>/     one workspace member per extension
  index.ts             entry: default export receives ExtensionAPI, wires pi.on(...) hooks
  index.test.ts        colocated bun:test suite
  package.json         member manifest with its own omp.extensions
```

## Commands

```sh
bun install           # link workspace members + dev-only types
bun test              # all member tests
bun check             # Biome check
bun sort-package-json # Sort package.json files
bun typecheck         # tsc --noEmit
```

## Conventions

- **`@oh-my-pi/pi-coding-agent` is dev-only** — import with `import type` only, so it
  erases and git-install consumers pull zero runtime deps.
- **Strict TypeScript** (`strict` + `noUnused*`, `noUncheckedIndexedAccess`, …). Don't
  loosen `tsconfig.json`; write to satisfy it.
- **Colocate `bun:test`** and **export pure helpers** so logic is tested without a live
  session (see `rules-guard`'s `decide`/`buildPolicy`). Fail closed on security paths.

## Adding an extension

1. `mkdir extensions/<name>` with a `package.json` (`name`, `version`,
   `omp.extensions: ["./index.ts"]`).
2. Add its entry to the **root** `omp.extensions` array — a member missing from it won't load.
3. `bun install`.

## Included extensions

| Extension     | What it does                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules-guard` | Enforces the Claude `permissions` allow/deny policy across every omp tool. Read the `index.ts` docblock for the threat model before touching policy logic. |
