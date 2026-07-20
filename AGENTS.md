# AGENTS.md

**omp-plugins** — personal [oh-my-pi](https://github.com/can1357/oh-my-pi)
extensions, published as one installable plugin. Install/update/uninstall live in
[`README.md`](./README.md); this file is for _changing_ the code.

The repo root is the plugin manifest: root `package.json` `omp.features` declares every
extension as a selectable feature (all `default: true`), so a bare install pulls the whole
suite and a bracketed spec loads a subset. Each extension is a Bun workspace member
under `extensions/*`. TypeScript run directly by [Bun](https://bun.com/docs/llms.txt)
(1.x, Node 24) — **no build step**.

## Layout

```text
package.json           root manifest; omp.features map = the install contract (one feature per extension)
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

## Versioning & releases

One version for the whole suite: **root** `package.json` `version`. It is what OMP records
in `omp-plugins.lock.json` and shows in `omp plugin list`; the git ref a consumer installs
(`#vX.Y.Z`) decides the actual code. `extensions/*` members are pinned to `0.0.0` and never
versioned independently — OMP never reads a member `version` for a git install.

[release-please](https://github.com/googleapis/release-please) automates it
(`.github/workflows/release-please.yaml` + `release-please-config.json` +
`.release-please-manifest.json`). Write merges to `master` as
[Conventional Commits](https://www.conventionalcommits.org/) — `fix:` → patch, `feat:` →
minor, `feat!:`/`fix!:` → major. It maintains a release PR; merging it bumps the root
`version`, writes `CHANGELOG.md`, and tags `vX.Y.Z`. Non-conventional commits accrue no
release. The action runs on the default `GITHUB_TOKEN`, so the release PR does **not**
re-trigger CI (its diff is `version` + changelog only).

Conventional Commits are **required**, not just conventional here: the `commit-msg` hook in
`hk.pkl` (`check_conventional_commit`, run via `hk util`) rejects a non-conforming message
locally. `mise`'s `enter` hook runs `hk install`, so the hook wires itself on first shell
entry; run `hk install` manually if committing outside that shell. **PR titles must follow
the convention too** — squash-merging a PR uses its title as the commit subject, which is
what release-please parses on `master`.

## Adding an extension

1. `mkdir extensions/<name>` with a `package.json` (`name`, `"version": "0.0.0"`,
   `omp.extensions: ["./index.ts"]`).
2. Add a feature entry to the **root** `omp.features` map: `"<name>": { "description": "…", "default": true, "extensions": ["./extensions/<name>/index.ts"] }`. `default: true` keeps it in the bare whole-suite install; the key is the `[<name>]` selector. A member missing from it won't load.
3. `bun install`.

## Included extensions

| Extension      | What it does                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules-guard`  | Enforces the Claude `permissions` allow/deny policy across every omp tool. Read the `index.ts` docblock for the threat model before touching policy logic. |
| `usage-status` | Color-coded `aboveEditor` widget row showing remaining usage + reset countdowns for every provider/account `authStorage.fetchUsageReports` returns (data-driven, like `/usage`), not a fixed provider list. |
