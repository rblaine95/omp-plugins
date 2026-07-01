# omp-plugins

Personal [oh-my-pi](https://omp.sh) extensions, published as one installable plugin.

The repo root is itself the plugin manifest: root `package.json` `omp.extensions` lists
every extension entry point, so a single `omp plugin install` pulls the whole suite. Each
extension lives in its own Bun workspace member under `extensions/*` for isolated
development and testing.

## Install

```sh
omp plugin install github:rblaine95/omp-plugins
```

Extensions load on the next omp start. `omp plugin list` shows `omp-plugins` as enabled.

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

| Extension     | What it does                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules-guard` | Enforces the Claude `permissions` allow/deny policy across every omp tool (read/write/edit/find/search/bash/eval/browser), not just `bash`. |

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
2. Add the entry to the root `package.json` `omp.extensions` array, which is what a git install reads.
3. `bun install` to register the new workspace member.
