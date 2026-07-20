# omp-plugins

Personal [oh-my-pi](https://omp.sh) extensions, published as one installable plugin.

The repo root is itself the plugin manifest: root `package.json` `omp.features` declares
every extension as a selectable feature (all `default: true`), so a bare `omp plugin
install` enables the whole suite while a bracketed spec enables just the features you name.
Each extension lives in its own Bun workspace member under `extensions/*` for isolated
development and testing.

## Install

All specs install the same single `omp-plugins` package (both extension directories come
with it); the bracket only selects which features **load**:

```sh
omp plugin install github:rblaine95/omp-plugins                      # enable whole suite
omp plugin install 'github:rblaine95/omp-plugins[rules-guard]'       # enable just rules-guard
omp plugin install 'github:rblaine95/omp-plugins[usage-status]'      # enable just usage-status
omp plugin install 'github:rblaine95/omp-plugins[*]'                 # all features, explicit
```

Quote any bracketed spec — shells like zsh treat `[...]` as a glob. Extensions load on the
next omp start. `omp plugin list` shows the one `omp-plugins` package as enabled regardless
of selection. Change which features load later, without reinstalling, via
`omp plugin features @rblaine95/omp-plugins`.

> Marketplace installs (`name@marketplace`) cannot activate these — omp loads
> `omp.extensions`/`omp.features` only for git/npm/`link` installs, never from a marketplace
> cache. Use the `omp plugin install github:…` commands above.

## Update

Git plugins have no separate update command. Re-run install and Bun re-resolves the ref to
its latest commit:

```sh
omp plugin install github:rblaine95/omp-plugins            # latest on default branch
omp plugin install 'github:rblaine95/omp-plugins#vX.Y.Z'   # pin a released tag (see Releases)
```

## Releases

Versioning is automated with [release-please](https://github.com/googleapis/release-please).
The **root** `package.json` `version` is the single version of the whole suite — it is the
value `omp plugin list` shows and `omp-plugins.lock.json` records. Workspace members under
`extensions/*` are pinned to `0.0.0` and never versioned independently.

Merges to `master` written as [Conventional Commits](https://www.conventionalcommits.org/)
(`fix:` → patch, `feat:` → minor, `feat!:`/`fix!:` → major) accrue into a release PR. Merging
that PR bumps the root `version`, updates `CHANGELOG.md`, and tags `vX.Y.Z` with a matching
GitHub Release — which is what the `#vX.Y.Z` pin above resolves to. Commits without a
conventional prefix are ignored, so no release PR opens until at least one lands.

## Uninstall

```sh
omp plugin uninstall @rblaine95/omp-plugins
```

## Included extensions

| Extension      | What it does                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules-guard`  | Enforces the Claude `permissions` allow/deny policy across every omp tool (read/write/edit/find/search/bash/eval/browser), not just `bash`.         |
| `usage-status` | Color-coded row above the editor showing remaining usage with reset countdowns for every subscription `/usage` reports (Claude, Codex, Gemini, Grok, OpenCode, Cursor, …), so you don't have to run `/usage`. |

## Local development

```sh
bun install  # link workspace members, install dev-only types
bun test     # run all member tests
```

Develop against your live omp without publishing by symlinking the local checkout:

```sh
omp plugin link /path/to/omp-plugins
```

`@oh-my-pi/pi-coding-agent` is a dev-only dependency (types for `ExtensionAPI`). The
extensions import it with `import type` only, so it is erased at build time and a git
install pulls in zero runtime dependencies.

## Adding an extension

1. `mkdir extensions/<name>` with its own `package.json` (`name`, `"version": "0.0.0"`, `omp.extensions: ["./index.ts"]`) — members are not versioned independently.
2. Add a feature entry to the root `package.json` `omp.features` map — `{ "description": "…", "default": true, "extensions": ["./extensions/<name>/index.ts"] }`. This is what a git install reads; `default: true` keeps it in the bare whole-suite install, and its key becomes the `[<name>]` selector.
3. `bun install` to register the new workspace member.
