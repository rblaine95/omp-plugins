/**
 * rules-guard tests — allow/deny precedence by specificity.
 * Run: `bun test` inside agent/extensions/rules-guard.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPolicy,
  decide,
  EMBEDDED_ALLOW,
  fileVerdict,
  globSpecificity,
  loadPolicyEntries,
  type Policy,
} from "./index";

const HOME = "/home/test";
const readBlocked = (path: string, pol: Policy, cwd = "/work") =>
  decide("read", { path }, cwd, pol).block;
const writeBlocked = (path: string, pol: Policy, cwd = "/work") =>
  decide("write", { path }, cwd, pol).block;

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
  test("shell read of a template is allowed (cat .env.example)", () => {
    expect(
      decide("bash", { command: "cat .env.example" }, "/work", pol).block,
    ).toBe(false);
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
