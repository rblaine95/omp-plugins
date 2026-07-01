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

Git plugins have no separate update command — re-run install; Bun re-resolves the ref to
its latest commit:

```sh
omp plugin install github:rblaine95/omp-plugins            # latest on default branch
omp plugin install 'github:rblaine95/omp-plugins#v1.0.0'   # pin a tag/commit for reproducibility
```

## Uninstall

```sh
omp plugin uninstall omp-plugins
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
omp plugin link /Users/robbie/Documents/projects/omp-plugins
```

`@oh-my-pi/pi-coding-agent` is a **dev-only** dependency (types for `ExtensionAPI`). The
extensions import it as `import type` only, so it is erased at build time — consumers
installing via git pull no runtime dependencies.

## Adding an extension

1. `mkdir extensions/<name>` with its own `package.json` (`name`, `version`, `omp.extensions: ["./index.ts"]`).
2. Add the entry to the **root** `package.json` `omp.extensions` array — this is what a git install reads.
3. `bun install` to register the new workspace member.
