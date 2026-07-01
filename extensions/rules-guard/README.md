# rules-guard

Enforces the Claude `permissions` allow/deny policy across every omp tool
(`read`, `write`, `edit`, `find`, `search`, `bash`, `eval`, `browser`), not only `bash`.

## Why it exists

omp's built-in `bashInterceptor` inspects only the `bash` tool, so a `permissions.deny`
rule like `Read(**/.env*)` is easy to sidestep by calling `read`, `write`, `edit`, `find`,
`search`, or `eval` directly. `rules-guard` registers a `tool_call` guard that runs before
every tool and fail-closes on any attempt to touch a denied path or run a denied command,
which closes that gap.

## Policy sources

At startup the extension reads both Claude settings files, pulls their `permissions.deny`
and `permissions.allow` arrays, and merges them with the opinionated defaults:

| Source | What it contributes |
| --- | --- |
| `~/.claude/settings.json` | Your personal `permissions.deny` and `permissions.allow`. |
| `~/.claude/remote-settings.json` | Organization policy. On Team and Enterprise plans this file is managed by org admins, so central rules apply automatically with no local opt-in. |
| Opinionated defaults (`index.ts`) | An opinionated default deny/allow list baked into the source, so the guard still works standalone when a file is missing or invalid. |

All three merge into one policy. A missing or unparseable file is skipped without error,
and the guard falls back to the remaining file plus the opinionated defaults. Rules compile
once when the extension loads. The active counts appear in a `session_start` notification,
for example `20 deny / 2 allow rules across all tools`.

Rules use Claude's `Tool(pattern)` form:

```jsonc
{
  "permissions": {
    "deny": [
      "Read(**/.env*)",       // no tool may read dotenv files
      "Read(**/.ssh/**)",     // ... or ssh material
      "Read(**/*.pem)",       // ... or private keys
      "Write(**/.env*)",      // no tool may write them either
      "Bash(rm -rf *)",       // command patterns are matched too
      "Bash(git push --force *)"
    ],
    "allow": [
      "Read(**/.env.example)" // a more-specific allow overrides a broad deny
    ]
  }
}
```

## What it enforces

Protected file reads and writes across all tools. Detection is field-driven rather than
tool-name-driven: any `path`, `paths`, `file`, or `files` field, `edit` hashline patch
headers (`[PATH#TAG]`), and path-shaped tokens inside `command`, `script`, or `code`
fields are all checked. Read-class denies apply to every tool, since anything can read
bytes; write-class denies apply additionally to write tools, unknown tools, and shell or
code execution. Paths are resolved (`~`, cwd), read selectors (`:50-100`, `:raw`) are
stripped, and archive members (`a.zip:secrets/k`) are decomposed so each piece is checked.

Denied bash command patterns. `Bash(...)` rules are matched against each command segment
of a shell-command field (`command`, `cmd`, `script`), so `rm -rf *` or `git push --force`
is blocked in `bash` and any other tool that carries such a field.

Secret-shaped output redaction on `tool_result`, as defense in depth. Substrings that
look like credentials are replaced with `[REDACTED]`:

- Anthropic (`sk-ant-...`), OpenAI (`sk-...`, `pk-...`)
- Stripe (`sk_live_...`, `rk_test_...`)
- AWS access-key ids (`AKIA...`) and, in context, secret access keys
- GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_...`, `github_pat_...`), GitLab (`glpat-...`)
- Slack (`xox[baprs]-...`, `xapp-...`, webhook URLs)
- Google (`AIza...`, `ya29....`, OAuth client ids)
- npm (`npm_...`), PyPI (`pypi-...`)
- SendGrid (`SG....`), DigitalOcean (`dop_v1_...`), Shopify (`shpat_...`), Twilio (`SK...`), Discord bot tokens
- JWTs and PEM private-key blocks
- Credentials embedded in connection URLs (`scheme://user:password@host/...`)

Bare high-entropy strings, git SHAs, and UUIDs are deliberately not redacted, to keep
false positives out of normal tool output.

When a call is blocked the model gets a specific reason instead of a silent failure. The
reason names the matched rule, for example `Blocked by deny policy: "..." matches
Read(**/.env*)`, and tells the model to ask the user for the file instead of reading,
writing, or referencing it.

## Precedence: most-specific wins

Claude resolves conflicts by always letting `deny` win. `rules-guard` instead resolves
them by specificity, the count of literal (non-wildcard) characters in the pattern. A path
is blocked only when a matching `deny` glob is at least as specific as every matching
`allow` glob of the same class. A strictly more specific `allow` overrides the deny, so
`Read(**/.env.example)` beats `Read(**/.env*)`: the example template stays readable while
real dotenv files stay blocked. Ties resolve to deny. A `Read(...)` allow overrides read
denies only, `Write(...)` write denies only. Bash denies are final, and a bare tool allow
(`Read`, with no parentheses) never widens a deny.

## Not a sandbox

This is a guard, not a jail. Extensions run in-process, and `bash` or `eval` can read bytes
in ways a text scan cannot fully enumerate: a bare `cat server.key` with no path separator,
base64, a custom interpreter, and similar tricks. The only hard boundary is OS filesystem
permissions, so run omp as a user without read access to these paths, or in a container
where they are not mounted. `rules-guard` stops the common and accidental paths and gives
the model a clear reason to stop.

## Development

```sh
bun test  # runs extensions/rules-guard/index.test.ts against the exported pure helpers
```

The decision logic (`decide`, `buildPolicy`, `compileGlob`, `fileVerdict`, `redactText`,
and the other helpers) is exported and unit-tested without a live session.
