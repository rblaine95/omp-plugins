/**
 * rules-guard tests — allow/deny precedence by specificity.
 * Run: `bun test` inside agent/extensions/rules-guard.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import rulesGuard, {
  bashMatcher,
  buildPolicy,
  candidateAbsPaths,
  compileGlob,
  decide,
  EMBEDDED_ALLOW,
  EMBEDDED_DENY,
  fileVerdict,
  globSpecificity,
  loadPolicyEntries,
  type Policy,
  parseRule,
  pathTokens,
  redactText,
} from "./index";

const HOME = "/home/test";
const readBlocked = (path: string, pol: Policy, cwd = "/work") =>
  decide("read", { path }, cwd, pol).block;
const writeBlocked = (path: string, pol: Policy, cwd = "/work") =>
  decide("write", { path }, cwd, pol).block;

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so fuzz cases are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randStr(rng: () => number, len: number, alphabet: string): string {
  let s = "";
  for (let i = 0; i < len; i++)
    s += alphabet.charAt(Math.floor(rng() * alphabet.length));
  return s;
}

function must<T>(v: T | undefined | null): T {
  if (v == null) throw new Error("expected a value");
  return v;
}

/** Run `fn` with a throwaway temp dir, always cleaned up. */
function inTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rg-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type AnyHandler = (event: unknown, ctx: unknown) => unknown;

/** Minimal ExtensionAPI stand-in that captures registered handlers + label. */
function makeMockPi(): {
  pi: ExtensionAPI;
  handlers: Map<string, AnyHandler>;
  state: { label: string };
} {
  const handlers = new Map<string, AnyHandler>();
  const state = { label: "" };
  const pi = {
    setLabel: (l: string) => {
      state.label = l;
    },
    on: (event: string, handler: AnyHandler) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, state };
}

describe("globSpecificity", () => {
  test("wildcards count as zero, literals as one", () => {
    expect(globSpecificity("**/.env*", HOME)).toBe(5); // /.env
    expect(globSpecificity("**/.env.example", HOME)).toBe(13); // /.env.example
    expect(globSpecificity("/foo/bar/**", HOME)).toBe(9); // /foo/bar/
    expect(globSpecificity("/foo/bar/baz", HOME)).toBe(12);
    expect(globSpecificity("**", HOME)).toBe(0);
    expect(globSpecificity("a?c", HOME)).toBe(2); // ? is a wildcard
  });
  test("~ expands before counting", () => {
    expect(globSpecificity("~", HOME)).toBe("/home/test".length); // 10
  });
});

describe(".env goal — allow templates, deny the rest", () => {
  const pol = buildPolicy(
    ["Read(**/.env*)", "Write(**/.env*)"],
    ["Read(**/.env.example)", "Read(**/.env.default)"],
  );

  test("broad .env reads stay blocked", () => {
    expect(readBlocked("/work/.env", pol)).toBe(true);
    expect(readBlocked("/work/.env.production", pol)).toBe(true);
    expect(readBlocked("/work/.env.local", pol)).toBe(true);
  });
  test("specific allow overrides the deny for templates", () => {
    expect(readBlocked("/work/.env.example", pol)).toBe(false);
    expect(readBlocked("/work/.env.default", pol)).toBe(false);
  });
  test("allow floats to any depth", () => {
    expect(readBlocked("/work/a/b/c/.env.example", pol)).toBe(false);
    expect(readBlocked("/work/a/b/c/.env.secret", pol)).toBe(true);
  });
  test("a Read allow does NOT unblock a Write deny (class-matched)", () => {
    // Write(**/.env*) has no write-class allow → writing .env.example blocked.
    expect(writeBlocked("/work/.env.example", pol)).toBe(true);
  });
  test("shell reference to a write-denied template is conservatively blocked", () => {
    // The token scan can't tell `cat` from `echo >`, so a Write(**/.env*) deny now
    // blocks .env.example in shell context; the read tool still permits it (see above).
    expect(
      decide("bash", { command: "cat .env.example" }, "/work", pol).block,
    ).toBe(true);
  });
  test("shell read of a real .env is still blocked", () => {
    expect(
      decide("bash", { command: "cat .env.production" }, "/work", pol).block,
    ).toBe(true);
  });
  test("shell write to a denied .env is still caught via read-deny", () => {
    expect(
      decide("bash", { command: "echo x > .env.production" }, "/work", pol)
        .block,
    ).toBe(true);
  });
});

describe("specificity example from the request", () => {
  const pol = buildPolicy(["Read(/foo/bar/**)"], ["Read(/foo/bar/baz)"]);
  test("Read(/foo/bar/baz) wins over Read(/foo/bar/**)", () => {
    expect(readBlocked("/foo/bar/baz", pol)).toBe(false);
  });
  test("siblings under the broad deny stay blocked", () => {
    expect(readBlocked("/foo/bar/other", pol)).toBe(true);
    expect(readBlocked("/foo/bar/sub/deep", pol)).toBe(true);
  });
});

describe("ties resolve to deny (secure default)", () => {
  const pol = buildPolicy(["Read(**/x/secret.txt)"], ["Read(**/x/secret.txt)"]);
  test("equal specificity → blocked", () => {
    expect(readBlocked("/a/x/secret.txt", pol)).toBe(true);
  });
});

describe("bare or empty allow never widens a deny", () => {
  const pol = buildPolicy(
    ["Read(**/secrets/**)"],
    ["Read", "Read()", "Glob", "Bash(rm -rf *)"],
  );
  test("no path-allow globs are produced from bare/empty/bash entries", () => {
    expect(pol.readAllow).toHaveLength(0);
    expect(pol.writeAllow).toHaveLength(0);
  });
  test("denied secret path stays blocked", () => {
    expect(readBlocked("/work/secrets/key.json", pol)).toBe(true);
  });
});

describe("bash deny is final — allow cannot override", () => {
  const pol = buildPolicy(
    ["Bash(rm -rf *)"],
    ["Bash(rm -rf /tmp/x)", "Bash(rm -rf *)"],
  );
  test("matching command is blocked despite a more-specific bash allow", () => {
    expect(pol.bash).toHaveLength(1);
    expect(
      decide("bash", { command: "rm -rf /tmp/x" }, "/work", pol).block,
    ).toBe(true);
  });
});

describe("standalone opinionated defaults (no settings files)", () => {
  const { deny, allow } = loadPolicyEntries([]);
  test("opinionated default allow-list is present", () => {
    expect(allow).toEqual(EMBEDDED_ALLOW);
    expect(deny).toContain("Read(**/.env*)");
  });
  test("embedded policy already protects/permits .env files", () => {
    const pol = buildPolicy(deny, allow);
    expect(readBlocked("/work/.env.example", pol)).toBe(false);
    expect(readBlocked("/work/.env.secret", pol)).toBe(true);
  });
});

describe("live POLICY (built from the real settings files at load)", () => {
  test(".env.example readable, plain .env blocked, end-to-end", () => {
    expect(decide("read", { path: "/x/.env.example" }, "/x").block).toBe(false);
    expect(decide("read", { path: "/x/.env" }, "/x").block).toBe(true);
  });
});

describe("fileVerdict (direct)", () => {
  const pol = buildPolicy(["Read(/foo/bar/**)"], ["Read(/foo/bar/baz)"]);
  test("returns undefined when a stricter allow matches", () => {
    expect(
      fileVerdict(["/foo/bar/baz"], pol.readDeny, pol.readAllow),
    ).toBeUndefined();
  });
  test("returns the deny glob (with src) otherwise", () => {
    const hit = fileVerdict(["/foo/bar/x"], pol.readDeny, pol.readAllow);
    expect(hit?.src).toBe("Read(/foo/bar/**)");
  });
});

describe("compileGlob (glob semantics)", () => {
  test("** crosses segments; * and ? stay within one (positive+negative)", () => {
    expect(compileGlob("**/*.key", HOME).test("/a/b/c/id.key")).toBe(true);
    expect(compileGlob("/a/*/c", HOME).test("/a/b/c")).toBe(true);
    expect(compileGlob("/a/*/c", HOME).test("/a/b/x/c")).toBe(false);
    expect(compileGlob("a?c", HOME).test("abc")).toBe(true);
    expect(compileGlob("a?c", HOME).test("a/c")).toBe(false);
  });
  test("bare ** (no trailing slash) matches greedily across depth", () => {
    const re = compileGlob("/foo**", HOME);
    expect(re.test("/foobar")).toBe(true);
    expect(re.test("/foo/x/y")).toBe(true);
    expect(re.test("/fo")).toBe(false);
  });
  test("~ expands to home; trailing /** matches the dir itself", () => {
    expect(compileGlob("~/.ssh/**", HOME).test("/home/test/.ssh")).toBe(true);
    expect(compileGlob("~/.ssh/**", HOME).test("/home/test/.ssh/id")).toBe(
      true,
    );
    expect(compileGlob("~", HOME).test("/home/test")).toBe(true);
  });
  test("regex metacharacters are matched literally (adversarial)", () => {
    const re = compileGlob("/a.b+c(d)/x", HOME);
    expect(re.test("/a.b+c(d)/x")).toBe(true);
    expect(re.test("/axbxcxdx/x")).toBe(false);
  });
});

describe("bashMatcher (command head, boundary-safe)", () => {
  test("trailing * = any args; head matches only at a boundary", () => {
    const re = bashMatcher("git push --force *");
    expect(re.test("git push --force origin main")).toBe(true);
    expect(re.test("git push --force")).toBe(true);
    expect(re.test("git push --force-with-lease")).toBe(false);
  });
  test("literal whitespace is flexible; internal boundary respected", () => {
    expect(bashMatcher("rm -rf *").test("rm   -rf /tmp/x")).toBe(true);
    expect(bashMatcher("git reset --hard *").test("git reset --hardcore")).toBe(
      false,
    );
  });
});

describe("parseRule (adversarial)", () => {
  test("well-formed Tool(pattern) parses, incl. empty pattern", () => {
    expect(parseRule("Read(**/x)")).toEqual({ tool: "Read", pattern: "**/x" });
    expect(parseRule("  Write(a/b)  ")).toEqual({
      tool: "Write",
      pattern: "a/b",
    });
    expect(parseRule("Bash()")).toEqual({ tool: "Bash", pattern: "" });
  });
  test("malformed entries return null", () => {
    expect(parseRule("not a rule")).toBeNull();
    expect(parseRule("Read**/x)")).toBeNull();
    expect(parseRule("Read(**/x")).toBeNull();
    expect(parseRule("Read2(x)")).toBeNull();
    expect(parseRule("")).toBeNull();
  });
});

describe("candidateAbsPaths", () => {
  test("resolves relative + ~ against cwd/home; strips read selectors", () => {
    expect(candidateAbsPaths("foo.ts", "/work")).toEqual(["/work/foo.ts"]);
    expect(candidateAbsPaths("~/x", "/work")).toEqual([
      nodePath.join(os.homedir(), "x"),
    ]);
    expect(candidateAbsPaths("/work/foo.ts:50-100", "/work")).toEqual([
      "/work/foo.ts",
    ]);
    expect(candidateAbsPaths("/work/foo.ts:raw", "/work")).toEqual([
      "/work/foo.ts",
    ]);
  });
  test("skips URLs and data/mailto schemes and empty input (negative)", () => {
    expect(candidateAbsPaths("https://x.com/a", "/work")).toEqual([]);
    expect(candidateAbsPaths("data:text/plain,x", "/work")).toEqual([]);
    expect(candidateAbsPaths("mailto:a@b.c", "/work")).toEqual([]);
    expect(candidateAbsPaths("", "/work")).toEqual([]);
  });
  test("decomposes archive members, incl. a ~ inner segment", () => {
    const inner = `sec${"rets/k.json"}`;
    const out = candidateAbsPaths(`bundle.zip:${inner}`, "/work");
    expect(out).toContain(`/work/bundle.zip:${inner}`);
    expect(out).toContain("/work/bundle.zip");
    expect(out).toContain(`/work/${inner}`);
    expect(candidateAbsPaths("a.zip:~/x", "/work")).toContain(
      nodePath.join(os.homedir(), "x"),
    );
  });
});

describe("pathTokens (path-signal extraction)", () => {
  test("flags tokens carrying a path signal", () => {
    const toks = pathTokens("cat .env; open('~/.x/id'); read a/b.json");
    expect(toks).toContain(".env");
    expect(toks).toContain("~/.x/id");
    expect(toks).toContain("a/b.json");
  });
  test("leaves ordinary code identifiers untouched (negative)", () => {
    expect(pathTokens("process.env obj.key foo bar")).toEqual([]);
  });
});

describe("decide — path fields across tool classes", () => {
  const pol = buildPolicy(["Read(**/secrets/**)", "Write(**/out/**)"], []);
  test("array-valued path field is scanned element-wise", () => {
    expect(
      decide("read", { paths: ["/work/ok", "/work/secrets/k"] }, "/work", pol)
        .block,
    ).toBe(true);
    expect(
      decide("read", { paths: ["/work/ok", "/work/fine"] }, "/work", pol).block,
    ).toBe(false);
  });
  test("non-string/non-array field values are ignored, never block (negative)", () => {
    expect(decide("read", { path: 42 }, "/work", pol).block).toBe(false);
    expect(decide("read", { path: { nested: true } }, "/work", pol).block).toBe(
      false,
    );
    expect(decide("read", { paths: [1, null, {}] }, "/work", pol).block).toBe(
      false,
    );
    expect(decide("bash", { command: 99 }, "/work", pol).block).toBe(false);
  });
  test("read-only ignores write-deny; write/unknown tools honor it", () => {
    expect(decide("read", { path: "/work/out/x" }, "/work", pol).block).toBe(
      false,
    );
    expect(decide("write", { path: "/work/out/x" }, "/work", pol).block).toBe(
      true,
    );
    expect(decide("wibble", { path: "/work/out/x" }, "/work", pol).block).toBe(
      true,
    );
  });
  test("edit hashline header paths are checked in write context", () => {
    const body = `[/work/sec${"rets/k#1A2B"}]\n+x`;
    expect(decide("edit", { input: body }, "/work", pol).block).toBe(true);
    expect(decide("edit", { input: 42 }, "/work", pol).block).toBe(false);
  });
});

describe("decide — shell & code fields", () => {
  const pol = buildPolicy(["Bash(rm -rf *)", "Read(**/.ssh/**)"], []);
  test("denied bash pattern blocks after stripping sudo/env prefixes", () => {
    expect(
      decide("bash", { command: "sudo rm -rf /tmp/x" }, "/w", pol).block,
    ).toBe(true);
    expect(
      decide("bash", { command: "A=1 rm -rf /tmp/x" }, "/w", pol).block,
    ).toBe(true);
    expect(decide("bash", { command: "ls -la" }, "/w", pol).block).toBe(false);
  });
  test("path-token scan catches a shell/code read of a denied path", () => {
    expect(
      decide("bash", { command: "cat ~/.ssh/id_ed25519" }, "/home/test", pol)
        .block,
    ).toBe(true);
    expect(
      decide("eval", { code: "open('~/.ssh/id_ed25519')" }, "/home/test", pol)
        .block,
    ).toBe(true);
  });
});

describe("decide — adversarial bypass vectors", () => {
  test("path traversal (..) resolving INTO a denied dir is blocked", () => {
    const pol = buildPolicy(["Read(**/vault/**)"], []);
    expect(
      decide("read", { path: "/work/pub/../vault/k" }, "/work", pol).block,
    ).toBe(true);
    // ...and traversal OUT of a denied dir must NOT false-positive.
    expect(
      decide("read", { path: "/work/vault/../pub/k" }, "/work", pol).block,
    ).toBe(false);
  });
  test("a read-class deny binds write/edit/unknown tools (any tool reads bytes)", () => {
    const pol = buildPolicy(["Read(**/vault/**)"], []);
    for (const tool of ["write", "edit", "notebook", "zzz"])
      expect(decide(tool, { path: "/work/vault/k" }, "/work", pol).block).toBe(
        true,
      );
  });
  test("a denied command hidden after a shell separator is still caught", () => {
    const pol = buildPolicy(["Bash(danger *)"], []);
    const evasions = [
      "echo hi; danger now",
      "true && danger x",
      "false || danger y",
      "echo x | danger z",
      "echo x\ndanger w",
    ];
    for (const command of evasions)
      expect(decide("bash", { command }, "/w", pol).block).toBe(true);
    expect(decide("bash", { command: "echo a; echo b" }, "/w", pol).block).toBe(
      false,
    );
  });
  test("shell/code write to a Write-only-denied path is blocked (finding 1)", () => {
    const pol = buildPolicy(["Edit(/work/target.conf)"], []);
    // No matching Read deny — before the fix this bypassed the guard.
    expect(
      decide(
        "bash",
        { command: "echo evil >> /work/target.conf" },
        "/work",
        pol,
      ).block,
    ).toBe(true);
    expect(
      decide("eval", { code: "open('/work/target.conf','w')" }, "/work", pol)
        .block,
    ).toBe(true);
    // Read-only access to the same write-denied path must remain permitted.
    expect(readBlocked("/work/target.conf", pol)).toBe(false);
  });
});

describe("redactText (defense-in-depth)", () => {
  test("redacts each known secret shape (positive)", () => {
    expect(redactText(`x sk-ant-${"abcdefghij1234567"} y`)).toBe(
      "x [REDACTED] y",
    );
    expect(redactText(`pk-${"abcdefghij1234567"}`)).toBe("[REDACTED]");
    expect(redactText(`AKIA${"1234567890ABCDEF"}`)).toBe("[REDACTED]");
    expect(redactText(`ghp_${"a".repeat(36)}`)).toBe("[REDACTED]");
    expect(redactText(`github_pat_${"a".repeat(24)}`)).toBe("[REDACTED]");
    expect(redactText(`xoxb-${"1234567890-abc"}`)).toBe("[REDACTED]");
    const pem = "-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----";
    expect(redactText(pem)).toBe("[REDACTED]");
  });
  test("redacts every distinct secret in one blob (positive)", () => {
    const blob = `a ghp_${"a".repeat(36)} b AKIA${"1234567890ABCDEF"} c`;
    expect(redactText(blob)).toBe("a [REDACTED] b [REDACTED] c");
  });
  test("leaves non-secret / too-short / credential-free text unchanged (negative)", () => {
    expect(redactText("hello world")).toBe("hello world");
    expect(redactText("ghp_tooshort")).toBe("ghp_tooshort");
    expect(redactText("")).toBe("");
    // FP guards — secret-adjacent shapes that must NOT be redacted.
    expect(redactText("a1b2c3d4e5".repeat(4))).toBe("a1b2c3d4e5".repeat(4)); // git SHA (40-hex)
    expect(redactText("12345678-1234-1234-1234-123456789012")).toBe(
      "12345678-1234-1234-1234-123456789012",
    ); // UUID
    expect(redactText("https://user@github.com/x")).toBe(
      "https://user@github.com/x",
    ); // URL user, no password
    expect(redactText("https://example.com:8080/path")).toBe(
      "https://example.com:8080/path",
    ); // port, not credentials
  });
});

describe("redactText — provider token shapes (positive)", () => {
  test("redacts newly-added provider token shapes", () => {
    for (const s of [
      `gho_${"a".repeat(36)}`, // GitHub CLI OAuth token
      `gho_${"a".repeat(40)}`, // longer body — must match {36,}, not exactly 36
      `glpat-${"a".repeat(20)}`,
      `xapp-${"1234567890abc"}`,
      `AIza${"a".repeat(35)}`,
      `ya29.${"a".repeat(30)}`,
      `npm_${"a".repeat(36)}`,
      `pypi-${"a".repeat(20)}`,
      `SG.${"a".repeat(22)}.${"b".repeat(43)}`,
      `sk_live_${"a".repeat(24)}`,
      `dop_v1_${"a1b2c3d4".repeat(8)}`,
      `shpat_${"a1b2c3d4".repeat(4)}`,
      `SK${"a1b2c3d4".repeat(4)}`,
      `M${"a".repeat(23)}.${"a".repeat(6)}.${"a".repeat(27)}`,
      `123456789-${"a".repeat(32)}.apps.googleusercontent.com`,
      `eyJ${"a".repeat(10)}.eyJ${"a".repeat(10)}.${"a".repeat(20)}`,
      `ghs_${"a".repeat(36)}`, // classic server-to-server token
      `ghs_123456_${"A".repeat(40)}.${"B".repeat(60)}.${"C".repeat(40)}`, // stateless ghs_APPID_JWT
    ])
      expect(redactText(s)).toBe("[REDACTED]");
    // AWS secret access key only redacts in context (label + value).
    expect(redactText(`aws_secret_access_key = ${"A".repeat(40)}`)).toBe(
      "[REDACTED]",
    );
    // Slack webhook keeps the scheme, redacts the secret path.
    expect(
      redactText(`https://hooks.slack.com/services/T0/B0/${"a".repeat(20)}`),
    ).toBe("https://[REDACTED]");
  });
});

describe("redactText — credential URLs (positive)", () => {
  test("redacts credentials embedded in connection URLs", () => {
    expect(
      redactText(
        "postgres://postgresAdmin:posgresPassword@postgres:5432/my-db",
      ),
    ).toBe("[REDACTED]");
    expect(redactText("rediss://:password@redis:6379/0")).toBe("[REDACTED]");
    // secret in the query string is swept in with the DSN.
    expect(redactText("postgres://u:p@h/db?password=hunter2")).toBe(
      "[REDACTED]",
    );
    // only the URL is redacted; surrounding JSON delimiters are preserved.
    expect(redactText('{"url":"mysql://a:b@db/x"}')).toBe(
      '{"url":"[REDACTED]"}',
    );
  });
});

describe("loadPolicyEntries (settings file merge)", () => {
  test("merges file deny+allow atop defaults; drops non-strings", () => {
    inTempDir((dir) => {
      const f = nodePath.join(dir, "settings.json");
      fs.writeFileSync(
        f,
        JSON.stringify({
          permissions: { deny: ["Read(/x/y)", 123], allow: ["Read(/x/y/z)"] },
        }),
      );
      const { deny, allow } = loadPolicyEntries([f]);
      expect(deny).toContain("Read(/x/y)");
      expect(deny).toContain("Read(**/.env*)");
      expect(deny).not.toContain("123");
      expect(allow).toContain("Read(/x/y/z)");
      expect(allow).toEqual(expect.arrayContaining(EMBEDDED_ALLOW));
    });
  });
  test("missing / invalid / mis-shaped files fall back to defaults", () => {
    inTempDir((dir) => {
      const bad = nodePath.join(dir, "bad.json");
      fs.writeFileSync(bad, "{ not json ");
      const shaped = nodePath.join(dir, "shaped.json");
      fs.writeFileSync(
        shaped,
        JSON.stringify({ permissions: { deny: "nope" } }),
      );
      const { deny, allow } = loadPolicyEntries([
        bad,
        shaped,
        nodePath.join(dir, "nope.json"),
      ]);
      expect(deny).toEqual(EMBEDDED_DENY);
      expect(allow).toEqual(EMBEDDED_ALLOW);
    });
  });
});

describe("rulesGuard wiring — registration & session_start", () => {
  test("sets a label of the expected shape and registers three hooks", () => {
    const { pi, handlers, state } = makeMockPi();
    rulesGuard(pi);
    expect(state.label).toMatch(/^RULES guard \(\d+ deny \/ \d+ allow\)$/);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("tool_call")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
  });
  test("session_start notifies only when a UI is present", async () => {
    const { pi, handlers } = makeMockPi();
    rulesGuard(pi);
    const start = must(handlers.get("session_start"));
    const msgs: string[] = [];
    const ui = { notify: (m: string) => void msgs.push(m) };
    await start({}, { hasUI: true, ui });
    await start({}, { hasUI: false, ui });
    await start({}, undefined);
    expect(msgs).toHaveLength(1);
  });
});

describe("rulesGuard wiring — tool_call", () => {
  test("blocks a default-denied command; passes benign input & missing ctx", async () => {
    const { pi, handlers } = makeMockPi();
    rulesGuard(pi);
    const onCall = must(handlers.get("tool_call"));
    const hit = (await onCall(
      { toolName: "bash", input: { command: "rm -rf /tmp/x" } },
      { cwd: "/work" },
    )) as { block?: boolean } | undefined;
    expect(hit?.block).toBe(true);
    expect(
      await onCall({ toolName: "read", input: {} }, { cwd: "/work" }),
    ).toBeUndefined();
    expect(
      await onCall({ toolName: "read", input: {} }, undefined),
    ).toBeUndefined();
  });
});

describe("rulesGuard wiring — tool_result", () => {
  test("redacts secret text, passes non-text; skips clean/error/non-array", async () => {
    const { pi, handlers } = makeMockPi();
    rulesGuard(pi);
    const onResult = must(handlers.get("tool_result"));
    const tok = `ghp_${"a".repeat(36)}`;
    const red = (await onResult(
      {
        isError: false,
        content: [{ type: "image" }, { type: "text", text: `t ${tok}` }],
      },
      {},
    )) as { content?: Array<{ text?: string }> } | undefined;
    expect(red?.content?.[1]?.text).toBe("t [REDACTED]");
    const clean = await onResult(
      { isError: false, content: [{ type: "text", text: "nothing here" }] },
      {},
    );
    expect(clean).toBeUndefined();
    const err = await onResult(
      { isError: true, content: [{ type: "text", text: tok }] },
      {},
    );
    expect(err).toBeUndefined();
    expect(
      await onResult({ isError: false, content: "x" }, {}),
    ).toBeUndefined();
  });
});

// ── Fuzzy invariants (seeded → deterministic under coverageThreshold=1.0) ──────
const FUZZ_POL = buildPolicy(
  ["Read(**/secrets/**)", "Bash(rm -rf *)", "Write(**/.env*)"],
  ["Read(**/.env.example)"],
);
const FUZZ_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "eval",
  "glob",
  "z",
] as const;
const FUZZ_FIELDS = [
  "path",
  "paths",
  "command",
  "code",
  "input",
  "junk",
] as const;
const FUZZ_ALPHA = "abcXYZ/._~-*?:'\"()[]{} \n;&|=";

describe("fuzzy — decide & compileGlob never blow up", () => {
  test("decide tolerates arbitrary tool/field/value combos", () => {
    const rng = mulberry32(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const tool = FUZZ_TOOLS[Math.floor(rng() * FUZZ_TOOLS.length)] ?? "read";
      const field =
        FUZZ_FIELDS[Math.floor(rng() * FUZZ_FIELDS.length)] ?? "path";
      const val = randStr(rng, Math.floor(rng() * 24), FUZZ_ALPHA);
      const input: Record<string, unknown> =
        rng() < 0.5 ? { [field]: val } : { [field]: [val, val] };
      expect(() => decide(tool, input, "/work", FUZZ_POL)).not.toThrow();
    }
  });
  test("compileGlob output is always fully anchored, never throws", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const g = randStr(rng, 1 + Math.floor(rng() * 16), FUZZ_ALPHA);
      const re = compileGlob(g, HOME);
      expect(re.source.startsWith("^")).toBe(true);
      expect(re.source.endsWith("$")).toBe(true);
    }
  });
});

describe("fuzzy — redaction idempotence & deny coverage", () => {
  test("redactText is idempotent for random secret-ish strings", () => {
    const rng = mulberry32(42);
    const bits = ["sk-ant-", "AKIA", "ghp_", "xoxb-", "hello ", "1234", "-_"];
    for (let i = 0; i < 2000; i++) {
      let s = "";
      const n = 1 + Math.floor(rng() * 6);
      for (let j = 0; j < n; j++)
        s += bits[Math.floor(rng() * bits.length)] ?? "";
      const once = redactText(s);
      expect(redactText(once)).toBe(once);
    }
  });
  test("any leaf under a denied dir is blocked regardless of name", () => {
    const rng = mulberry32(99);
    const leaf = "abcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < 500; i++) {
      const name = randStr(rng, 1 + Math.floor(rng() * 12), leaf);
      expect(
        decide("read", { path: `/work/secrets/${name}` }, "/work", FUZZ_POL)
          .block,
      ).toBe(true);
    }
  });
});
