/**
 * rules-guard — enforce the Claude `permissions.deny` policy across ALL omp tools.
 *
 * Why this exists:
 *   omp's `bashInterceptor` only inspects the `bash` tool, so RULES.md is trivially
 *   bypassed by calling `read`/`write`/`edit`/`find`/`search`/`eval` directly. This
 *   `tool_call` guard runs before EVERY tool, fail-closes on any attempt to touch a
 *   denied path, and enforces the denied bash command patterns too. Two output
 *   passes redact secret-shaped text as defense in depth: `tool_result` (tool
 *   output, at record time) and `context` (messages on their way to the LLM).
 *
 * Why the `context` pass exists:
 *   the user execution surfaces bypass tool interception by design — `!cmd` runs
 *   through `AgentSession.executeBash()` and `$code` through the Python kernel,
 *   and neither fires `tool_call`/`tool_result`. So `!cat .env` put raw secrets
 *   straight into the model's context. That output is not a `content` array
 *   either; it lands as `{ role: "bashExecution", output }`. Blocking these
 *   surfaces is deliberately NOT attempted: they are the user's own shell escape.
 *   The pass redacts a TYPED carrier list — see `REDACT_CONTENT_ROLES` /
 *   `REDACT_STRING_FIELDS` — covering operator-originated bytes: user/developer/
 *   custom/tool-result text, `bashExecution`/`pythonExecution` command+output,
 *   `fileMention.files[].content` (`@path` auto-reads), and branch/compaction
 *   summaries. Two categories are excluded because rewriting them BREAKS the
 *   provider, not because they are safe: signed blocks (`assistant` text bound to
 *   `textSignature`, thinking bound to `thinkingSignature`) and opaque
 *   server-validated blobs (`providerPayload`, `details`, `redactedThinking`).
 *   The list is typed, so ADDING A MESSAGE TYPE REQUIRES ADDING IT HERE — a new
 *   carrier is not covered automatically.
 *
 * Policy source (read at load from ALL Claude settings files):
 *   - ~/.claude/settings.json           → permissions.deny + permissions.allow
 *   - ~/.claude/remote-settings.json    → permissions.deny + permissions.allow
 *   - <cwd>/.claude/settings.json       → permissions.deny + permissions.allow
 *   - <cwd>/.claude/settings.local.json → permissions.deny + permissions.allow
 *   All files plus the opinionated defaults below are merged, so the guard still
 *   works standalone when a file is missing/invalid.
 *
 * Precedence (unlike Claude, where deny always wins): the MORE SPECIFIC rule
 * wins. Specificity = count of literal (non-wildcard) characters in the pattern.
 * A path is blocked only when a matching `deny` glob is at least as specific as
 * every matching `allow` glob of the same class; a strictly-more-specific `allow`
 * overrides the deny (a specific `Read(.../.env.example)` allow beats a broad
 * `Read(.../.env*)` deny). Ties
 * resolve to deny. `Read(...)` allow overrides only read denies, `Write(...)`
 * only write denies. Bash denies are final — `allow` has no specificity model for
 * command patterns, and a bare tool allow (`Read`, no parens) never widens a deny.
 *
 * NOT a sandbox: extensions run in-process and bash/eval can read bytes in ways a
 * text scan cannot fully enumerate (a bare `cat server.key` with no path separator,
 * base64, custom interpreters, ...). The only hard boundary is OS filesystem
 * permissions — run omp as a user without read access to these paths, or in a
 * container where they are not mounted. This guard stops the common/accidental
 * paths and hands the model a clear, actionable reason.
 */

import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ── Opinionated default deny-list ────────────────────────────────────────────
export const EMBEDDED_DENY: string[] = [
  "Bash(git push --force *)",
  "Bash(git reset --hard *)",
  "Bash(rm -rf *)",
  "Edit(~/.bashrc)",
  "Edit(~/.zshrc)",
  "Read(**/*.id_ed25519)",
  "Read(**/*.id_rsa)",
  "Read(**/*.key)",
  "Read(**/*.pem)",
  "Read(**/.aws/**)",
  "Read(**/.env*)",
  "Read(**/.npmrc)",
  "Read(**/.pypirc)",
  "Read(**/.ssh/**)",
  "Read(**/secrets/**)",
  "Read(~/.config/gh/**)",
  "Read(~/.git-credentials)",
  "Read(~/.gnupg/**)",
  "Read(~/.npmrc)",
  "Write(**/.env*)",
  "Write(**/.ssh/**)",
];

// ── Opinionated default allow-list (a more-specific allow overrides a deny) ────
// Only path-bearing `Tool(pattern)` rules belong here; a bare tool allow (e.g.
// "Read") must NEVER widen a path/bash deny. `.env.example` / `.env.default` are
// safe templates, so they win over the broad `Read(**/.env*)` deny above.
export const EMBEDDED_ALLOW: string[] = [
  "Read(**/.env.example)",
  "Read(**/.env.default)",
];

// Default Claude settings files that contribute policy rules: the user + org
// files under `~/.claude`, plus the project-scoped `.claude/settings.json`
// (shared, committed) and `.claude/settings.local.json` (local, git-ignored)
// under `cwd`. Order is irrelevant to the final policy (precedence is by
// specificity, not position); a missing file is skipped. Pure + injectable for
// tests, matching `compileGlob`/`globSpecificity`.
export function claudeFiles(
  home: string = os.homedir(),
  cwd: string = process.cwd(),
): string[] {
  return [
    nodePath.join(home, ".claude", "settings.json"),
    nodePath.join(home, ".claude", "remote-settings.json"),
    nodePath.join(cwd, ".claude", "settings.json"),
    nodePath.join(cwd, ".claude", "settings.local.json"),
  ];
}

const CLAUDE_FILES = claudeFiles();

// Claude permission "tool" names mapped onto omp tool classes.
const CLAUDE_READ_TOOLS: Record<string, true> = {
  Read: true,
  Glob: true,
  Grep: true,
  LS: true,
  NotebookRead: true,
};
const CLAUDE_WRITE_TOOLS: Record<string, true> = {
  Edit: true,
  Write: true,
  Update: true,
  MultiEdit: true,
  NotebookEdit: true,
};

// omp tool name → read/write classification (selects glob strictness only;
// detection itself is field-driven below, so unknown tools are still checked).
const READ_CLASS: Record<string, true> = {
  read: true,
  search: true,
  grep: true,
  find: true,
  glob: true,
  ast_grep: true,
  list: true,
  ls: true,
  cat: true,
  notebook_read: true,
};
const WRITE_CLASS: Record<string, true> = {
  write: true,
  edit: true,
  multiedit: true,
  multi_edit: true,
  apply_patch: true,
  str_replace: true,
  notebook: true,
  notebook_edit: true,
  ast_edit: true,
  create: true,
};

// Input field names that carry filesystem paths / executable text, across all tools.
const PATH_FIELDS: Record<string, true> = {
  path: true,
  paths: true,
  file: true,
  files: true,
  filename: true,
  filenames: true,
};
const SHELL_FIELDS: Record<string, true> = {
  command: true,
  cmd: true,
  script: true,
};
const CODE_FIELDS: Record<string, true> = { code: true };

// ── Rule compilation ──────────────────────────────────────────────────────────

export interface FileGlob {
  re: RegExp;
  src: string;
  /** literal (non-wildcard) char count; higher = more specific. */
  spec: number;
}
export interface BashRule {
  re: RegExp;
  src: string;
}
export interface Policy {
  readDeny: FileGlob[];
  writeDeny: FileGlob[];
  readAllow: FileGlob[];
  writeAllow: FileGlob[];
  bash: BashRule[];
}

export function parseRule(
  entry: string,
): { tool: string; pattern: string } | null {
  const m = /^([A-Za-z_]+)\((.*)\)$/.exec(entry.trim());
  if (!m) return null;
  const [, tool, pattern] = m;
  if (tool === undefined || pattern === undefined) return null;
  return { tool, pattern };
}

/**
 * Compile a Claude/gitignore-style glob into a RegExp tested against an absolute
 * path. `**` crosses path segments, `*`/`?` stay within a segment, `~` expands to
 * home, a trailing `/**` also matches the directory itself, and a leading
 * `**`/relative pattern floats (matches at any depth).
 */
export function compileGlob(glob: string, home: string = os.homedir()): RegExp {
  let g = glob.trim();
  if (g === "~") g = home;
  else if (g.startsWith("~/")) g = home + g.slice(1);

  const floating = !(g.startsWith("/") || g.startsWith(home));

  let trailingDir = false;
  if (g.endsWith("/**")) {
    g = g.slice(0, -3);
    trailingDir = true;
  }

  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g.charAt(i);
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") {
        re += "(?:.*/)?";
        i++;
      } else {
        re += ".*";
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.\\^$+(){}[\]|]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }

  const prefix = floating ? "(?:.*/)?" : "";
  const suffix = trailingDir ? "(?:/.*)?" : "";
  return new RegExp(`^${prefix}${re}${suffix}$`);
}

/**
 * Specificity of a glob: count of literal (non-wildcard) characters after `~`
 * expansion (`*`, `**`, `?` count as zero). Higher = more specific. Lets a
 * precise rule win over a broad one, on either the allow or the deny side.
 */
export function globSpecificity(
  glob: string,
  home: string = os.homedir(),
): number {
  let g = glob.trim();
  if (g === "~") g = home;
  else if (g.startsWith("~/")) g = home + g.slice(1);
  let n = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") i++;
      continue;
    }
    if (c === "?") continue;
    n++;
  }
  return n;
}

/**
 * Compile a Claude `Bash(...)` pattern into a RegExp tested against one command
 * segment. A trailing `*` ("any args") is dropped; literal whitespace becomes
 * `\s+`; a non-word/non-hyphen boundary is required after the matched head so
 * `git push --force *` does NOT match the safe `git push --force-with-lease`.
 */
export function bashMatcher(pattern: string): RegExp {
  const head = pattern.trim().replace(/\s*\*+\s*$/, "");
  const esc = head
    .replace(/[.\\+?^${}()|[\]]/g, "\\$&")
    .replace(/\s+/g, "\\s+")
    .replace(/\*/g, "[^\\s]*");
  return new RegExp(`^${esc}(?![-\\w])`);
}

export function buildPolicy(
  denyEntries: string[],
  allowEntries: string[] = [],
  home: string = os.homedir(),
): Policy {
  const readDeny: FileGlob[] = [];
  const writeDeny: FileGlob[] = [];
  const readAllow: FileGlob[] = [];
  const writeAllow: FileGlob[] = [];
  const bash: BashRule[] = [];

  const mkGlob = (pattern: string, src: string): FileGlob => ({
    re: compileGlob(pattern, home),
    src,
    spec: globSpecificity(pattern, home),
  });

  // deny: file globs by class + bash patterns (bash is deny-only).
  const denySeen = new Set<string>();
  for (const e of denyEntries) {
    if (typeof e !== "string" || denySeen.has(e)) continue;
    denySeen.add(e);
    const r = parseRule(e);
    if (!r) continue;
    if (r.tool === "Bash") bash.push({ re: bashMatcher(r.pattern), src: e });
    else if (CLAUDE_READ_TOOLS[r.tool]) readDeny.push(mkGlob(r.pattern, e));
    else if (CLAUDE_WRITE_TOOLS[r.tool]) writeDeny.push(mkGlob(r.pattern, e));
    // other Claude tools (WebFetch, etc.) have no omp filesystem analogue → ignore
  }

  // allow: path-bearing file globs only. A bare tool allow (`Read`, no parens) or
  // an empty pattern (`Read()`) is skipped so it cannot widen a deny; bash allows
  // are ignored so command denies stay final.
  const allowSeen = new Set<string>();
  for (const e of allowEntries) {
    if (typeof e !== "string" || allowSeen.has(e)) continue;
    allowSeen.add(e);
    const r = parseRule(e);
    if (!r || r.pattern.trim() === "" || r.tool === "Bash") continue;
    if (CLAUDE_READ_TOOLS[r.tool]) readAllow.push(mkGlob(r.pattern, e));
    else if (CLAUDE_WRITE_TOOLS[r.tool]) writeAllow.push(mkGlob(r.pattern, e));
  }

  return { readDeny, writeDeny, readAllow, writeAllow, bash };
}

export function loadPolicyEntries(files: string[] = CLAUDE_FILES): {
  deny: string[];
  allow: string[];
} {
  const deny = [...EMBEDDED_DENY];
  const allow = [...EMBEDDED_ALLOW];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
      const d = parsed?.permissions?.deny;
      const a = parsed?.permissions?.allow;
      if (Array.isArray(d))
        for (const x of d) if (typeof x === "string") deny.push(x);
      if (Array.isArray(a))
        for (const x of a) if (typeof x === "string") allow.push(x);
    } catch {
      // missing or invalid file → rely on the opinionated defaults + the other file
    }
  }
  return { deny, allow };
}

// ── Path / token helpers ────────────────────────────────────────────────────

/**
 * Absolute path candidates for one raw path argument. Resolves `~` and cwd,
 * strips read selectors (`:50-100`, `:raw`), and decomposes archive members
 * (`a.zip:secrets/k`) into inner sub-paths so each piece is checkable.
 */
export function candidateAbsPaths(raw: string, cwd: string): string[] {
  let p = (raw ?? "").trim();
  if (!p || /^[a-z][\w+.-]*:\/\//i.test(p) || /^(?:data|mailto):/i.test(p))
    return [];
  p = p.replace(/(:(?:\d[\w,+-]*|raw|conflicts))+$/i, "");
  const base = cwd || process.cwd();
  const home = os.homedir();
  const out = new Set<string>();
  out.add(
    nodePath.resolve(
      base,
      p.startsWith("~") ? nodePath.join(home, p.slice(1)) : p,
    ),
  );
  if (p.includes(":")) {
    for (const seg of p.split(":")) {
      const s = seg.trim();
      if (s)
        out.add(
          nodePath.resolve(
            base,
            s.startsWith("~") ? nodePath.join(home, s.slice(1)) : s,
          ),
        );
    }
  }
  return [...out];
}

/**
 * Path-shaped tokens from a command/code string. Conservative on purpose: a token
 * counts only if it carries a path signal (`/`, leading `~`, or a leading dotfile
 * dot). This blocks `cat .env`, `open('.env')`, `~/.ssh/id_ed25519`, `./x.key`,
 * `secrets/p.json`, while leaving ordinary code like `process.env` or `obj.key`
 * untouched. Bare `server.key` (no separator) is deliberately not flagged here.
 */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (let t of text.split(/[\s,;|&()<>'"`=]+/)) {
    t = t.replace(/^[([{]+|[)\]};,]+$/g, "");
    if (!t) continue;
    if (t.includes("/") || t.startsWith("~") || /^\.[^./]/.test(t)) out.push(t);
  }
  return out;
}

function asArr(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === "string");
  return [];
}

// Paths embedded in an `edit` hashline patch body: `[PATH#1A2B]`.
function editHeaderPaths(input: Record<string, unknown>): string[] {
  const body = input["input"] ?? input["_input"];
  if (typeof body !== "string") return [];
  const out: string[] = [];
  for (const m of body.matchAll(/\[([^\]\n#]+)#[0-9A-Fa-f]{3,8}\]/g)) {
    const p = m[1];
    if (p !== undefined) out.push(p.trim());
  }
  return out;
}

function fieldValues(
  input: Record<string, unknown>,
  fields: Record<string, true>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(input)) {
    if (!fields[key]) continue;
    for (const s of asArr(input[key])) out.push(s);
  }
  return out;
}

function fileMsg(target: string, src: string): string {
  return `Blocked by deny policy: "${target}" matches \`${src}\`. This is a protected secret/credential path — ask the User to fetch it; do not read, write, or reference it.`;
}

function bashSegments(cmd: string): string[] {
  const out: string[] = [];
  for (const raw of cmd.split(/\n|;|&&|\|\||[|&]/)) {
    let p = raw.trim();
    for (;;) {
      const m =
        /^(?:sudo|command|builtin|exec|time|nice|nohup)\s+/.exec(p) ||
        /^[A-Za-z_]\w*=[^\s]*\s+/.exec(p);
      if (!m) break;
      p = p.slice(m[0].length);
    }
    if (p) out.push(p);
  }
  return out;
}

/** Most-specific matching deny glob for these candidate paths, unless some
 *  matching allow glob is STRICTLY more specific (→ permitted, undefined). Ties
 *  resolve to deny. Exported for tests. */
export function fileVerdict(
  candidates: string[],
  denyGlobs: FileGlob[],
  allowGlobs: FileGlob[],
): FileGlob | undefined {
  let topDeny: FileGlob | undefined;
  for (const c of candidates)
    for (const g of denyGlobs)
      if (g.re.test(c) && (!topDeny || g.spec > topDeny.spec)) topDeny = g;
  if (!topDeny) return undefined;
  let topAllow = -1;
  for (const c of candidates)
    for (const g of allowGlobs)
      if (g.re.test(c) && g.spec > topAllow) topAllow = g.spec;
  return topAllow > topDeny.spec ? undefined : topDeny;
}

// ── Decision ──────────────────────────────────────────────────────────────────

export interface Decision {
  block: boolean;
  reason?: string;
}

/** Pure block/allow decision for one tool call. Detection is field-driven so it
 *  covers every tool (read/write/edit/find/grep/python/eval/browser/...) regardless
 *  of the exact registered name. Exported for tests. */
export function decide(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  policy: Policy = POLICY,
): Decision {
  const inp = input ?? {};
  const isWrite = WRITE_CLASS[toolName] === true;
  const readOnly = !isWrite && READ_CLASS[toolName] === true;

  // Block iff a matching deny is at least as specific as every matching allow of
  // the SAME class. Read-class applies to every tool (any tool can read bytes);
  // write-class applies additionally to write tools, unknown tools, and
  // shell/code execution (which can write).
  const blocked = (
    candidates: string[],
    includeWrite: boolean,
  ): FileGlob | undefined =>
    fileVerdict(candidates, policy.readDeny, policy.readAllow) ??
    (includeWrite
      ? fileVerdict(candidates, policy.writeDeny, policy.writeAllow)
      : undefined);

  // Target paths embedded in an edit/patch body (`[PATH#TAG]`) — write context.
  for (const raw of editHeaderPaths(inp)) {
    const hit = blocked(candidateAbsPaths(raw, cwd), true);
    if (hit) return { block: true, reason: fileMsg(raw, hit.src) };
  }

  // Explicit path-bearing fields. Read-only tools check read-class only; write &
  // unknown tools also check write-class.
  for (const raw of fieldValues(inp, PATH_FIELDS)) {
    const hit = blocked(candidateAbsPaths(raw, cwd), !readOnly);
    if (hit) return { block: true, reason: fileMsg(raw, hit.src) };
  }

  // Command / code fields (bash/python/eval/browser/...): first denied-command
  // patterns, then a path-token scan. Shell/code can BOTH read and write, and the
  // scan can't tell which, so it checks read- AND write-class denies
  // (includeWrite = true) — a Write(...)-only deny (e.g. `Edit(~/.bashrc)`) is thus
  // enforced against `echo >> ~/.bashrc`. Trade-off: a read-allowed-but-write-denied
  // path (`.env.example`) is conservatively blocked here, though the read tool
  // still permits it.
  const shellText = fieldValues(inp, SHELL_FIELDS);
  for (const text of shellText) {
    for (const seg of bashSegments(text)) {
      for (const b of policy.bash) {
        if (b.re.test(seg)) {
          return {
            block: true,
            reason: `Blocked by deny policy: command matches \`${b.src}\`. This operation is not permitted — ask the User.`,
          };
        }
      }
    }
  }
  for (const text of [...shellText, ...fieldValues(inp, CODE_FIELDS)]) {
    for (const tok of pathTokens(text)) {
      const hit = blocked(candidateAbsPaths(tok, cwd), true);
      if (hit) return { block: true, reason: fileMsg(tok, hit.src) };
    }
  }

  return { block: false };
}

// ── Output redaction (defense in depth) ───────────────────────────────────────

const SECRET_OUTPUT: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic (incl. sk-ant-api...)
  /\b(?:sk|pk)-[A-Za-z0-9_-]{16,}/g, // OpenAI (incl. sk-proj-...)
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret / restricted keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  // AWS secret access key: bare 40-char base64 is indistinguishable from a git SHA,
  // so match only in context (an aws-secret-ish label followed by `=`/`:`).
  /\baws_?secret_?access_?key[ \t]*[:=][ \t]*["']?[A-Za-z0-9/+]{40}/gi,
  // GitHub token — PAT ghp_, OAuth/CLI gho_, user-to-server ghu_, refresh ghr_.
  /\bgh[opru]_[A-Za-z0-9]{36,}/g,
  // GitHub server-to-server / installation token ghs_ — covers both the classic
  // 36-char form and the stateless ghs_APPID_JWT form (~520 chars, dot- and
  // underscore-separated), per GitHub's recommended `ghs_[A-Za-z0-9._-]{36,}`.
  /\bghs_[A-Za-z0-9._-]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub PAT (fine-grained)
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /\b(?:xox[baprs]|xapp)-[A-Za-z0-9-]{10,}/g, // Slack tokens (bot/user/app/...)
  /\bhooks\.slack\.com\/services\/[\w-]+\/[\w-]+\/[\w-]+/g, // Slack incoming webhook
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google OAuth access token
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm access token
  /\bpypi-[A-Za-z0-9_-]{16,}/g, // PyPI API token
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g, // SendGrid API key
  /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, // JWT (header.payload.signature)
  /\bdop_v1_[a-f0-9]{64}\b/g, // DigitalOcean PAT
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g, // Shopify access token
  /\bSK[0-9a-fA-F]{32}\b/g, // Twilio API key SID
  /\b[MNO][\w-]{23}\.[\w-]{6}\.[\w-]{27,}/g, // Discord bot token
  /\b[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com\b/g, // Google OAuth client id
  // Credentials embedded in a connection URL (scheme://[user]:password@host/...). The
  // password is required (`+`), so `https://user@host` and bare URLs are left alone.
  // Match runs through the path/query (stopping at whitespace/quote/bracket) so a
  // credentialed DSN's host, port, db name, and query secrets are all redacted.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]+@[^\s'"`<>)]+/gi,
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, // PEM private key
];

/** Redact secret-shaped substrings from tool output text. Exported for tests. */
export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_OUTPUT) out = out.replace(re, "[REDACTED]");
  return out;
}

/**
 * Roles whose `content` is `string | (TextContent | ImageContent)[]`.
 *
 * `assistant` is absent BY DESIGN, not by omission: a `text` block carrying a
 * `textSignature` is bound to its exact bytes, and rewriting the text while
 * keeping the signature makes the provider 400 the replay (see
 * `session-persistence.ts` — "never truncate, externalize, or descend"). Model
 * output is also not what this pass defends against; it targets operator-
 * originated bytes (files, command output, mentions).
 */
const REDACT_CONTENT_ROLES: Record<string, true> = {
  user: true,
  developer: true,
  toolResult: true,
  custom: true,
  hookMessage: true,
};

/** Per-role plain-string fields to redact. All unsigned, all operator-facing. */
const REDACT_STRING_FIELDS: Record<string, readonly string[]> = {
  // `command`/`code` are redacted too: `!curl -H "Authorization: Bearer …"` is a
  // real carrier, and neither field is signed.
  bashExecution: ["command", "output"],
  pythonExecution: ["code", "output"],
  branchSummary: ["summary"],
  compactionSummary: ["summary", "shortSummary"],
};

/**
 * Copy-on-write redaction of operator-originated text in a message list.
 * Returns a NEW array when anything changed, else `undefined` (the common path).
 *
 * Copy-on-write, not in-place: `ExtensionRunner.emitContext` deep-clones only on
 * a best-effort basis and falls back to `[...messages]` when `structuredClone`
 * throws, so in-place writes would corrupt the live session's persisted objects.
 * Unchanged nodes are shared by reference — a clean history allocates nothing.
 *
 * Typed per field rather than a blind deep walk: opaque provider-replay blobs
 * (`providerPayload`, `redactedThinking`) and untyped extension payloads
 * (`details`) are server-validated atomic data and must never be descended into.
 * Exported for tests.
 */
export function redactMessages<T>(messages: readonly T[]): T[] | undefined {
  let copy: T[] | undefined;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as T;
    const next = redactMessage(msg) as T;
    if (next === msg) continue;
    copy ??= [...messages];
    copy[i] = next;
  }
  return copy;
}

/** Redact one message; returns the original reference when nothing changed. */
function redactMessage(msg: unknown): unknown {
  if (msg === null || typeof msg !== "object") return msg;
  const m = msg as Record<string, unknown>;
  const role = m["role"];
  if (typeof role !== "string" || role === "assistant") return msg;

  let out: Record<string, unknown> | undefined;
  const set = (key: string, value: unknown): void => {
    out ??= { ...m };
    out[key] = value;
  };

  if (REDACT_CONTENT_ROLES[role]) {
    const content = m["content"];
    const next =
      typeof content === "string"
        ? redactText(content)
        : Array.isArray(content)
          ? redactBlocks(content)
          : content;
    if (next !== content) set("content", next);
  }

  for (const field of REDACT_STRING_FIELDS[role] ?? []) {
    const v = m[field];
    if (typeof v !== "string") continue;
    const next = redactText(v);
    if (next !== v) set(field, next);
  }

  if (role === "compactionSummary") {
    const blocks = m["blocks"];
    if (Array.isArray(blocks)) {
      const next = redactBlocks(blocks);
      if (next !== blocks) set("blocks", next);
    }
  }

  if (role === "fileMention") {
    const files = m["files"];
    if (Array.isArray(files)) {
      let copy: unknown[] | undefined;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file === null || typeof file !== "object") continue;
        const rec = file as Record<string, unknown>;
        const content = rec["content"];
        if (typeof content !== "string") continue;
        const next = redactText(content);
        if (next === content) continue;
        copy ??= [...files];
        copy[i] = { ...rec, content: next };
      }
      if (copy) set("files", copy);
    }
  }

  return out ?? msg;
}

/**
 * Redact `text` blocks in a content array, sharing untouched entries. Signed
 * blocks are skipped: the signature is bound to the exact bytes.
 */
function redactBlocks(blocks: readonly unknown[]): readonly unknown[] {
  let copy: unknown[] | undefined;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === null || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec["type"] !== "text" || typeof rec["textSignature"] === "string")
      continue;
    const text = rec["text"];
    if (typeof text !== "string") continue;
    const next = redactText(text);
    if (next === text) continue;
    copy ??= [...blocks];
    copy[i] = { ...rec, text: next };
  }
  return copy ?? blocks;
}

// ── Compiled policy (read once at load) ────────────────────────────────────────

const LOADED = loadPolicyEntries();
export const POLICY: Policy = buildPolicy(LOADED.deny, LOADED.allow);

// ── Extension wiring ────────────────────────────────────────────────────────────

export default function rulesGuard(pi: ExtensionAPI): void {
  const denyCount =
    POLICY.readDeny.length + POLICY.writeDeny.length + POLICY.bash.length;
  const allowCount = POLICY.readAllow.length + POLICY.writeAllow.length;
  pi.setLabel(`RULES guard (${denyCount} deny / ${allowCount} allow)`);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.hasUI) {
      ctx.ui.notify(
        `RULES guard active — ${denyCount} deny / ${allowCount} allow rules across all tools.`,
        "info",
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const verdict = decide(
      event.toolName,
      (event.input ?? {}) as Record<string, unknown>,
      ctx?.cwd ?? process.cwd(),
    );
    if (verdict.block) return { block: true, reason: verdict.reason };
  });

  pi.on("tool_result", async (event) => {
    if (event.isError || !Array.isArray(event.content)) return;
    let changed = false;
    const content = event.content.map((chunk) => {
      if (chunk.type !== "text") return chunk;
      const next = redactText(chunk.text);
      if (next === chunk.text) return chunk;
      changed = true;
      return { ...chunk, text: next };
    });
    if (changed) return { content };
  });

  // Last line before the model: redact the typed carrier list (see
  // `redactMessages`) — notably `!`/`$` output, which reaches context without
  // ever passing through `tool_call`/`tool_result`. Signed and opaque replay
  // data is excluded. Transient: the on-disk transcript keeps the real bytes.
  pi.on("context", async (event) => {
    if (!Array.isArray(event.messages)) return;
    const messages = redactMessages(event.messages);
    if (messages) return { messages };
  });
}
