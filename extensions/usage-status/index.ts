/**
 * usage-status — surface remaining subscription usage above the omp editor.
 *
 * `/usage` reports how much quota is left per subscription (rolling windows like
 * 5h / 7d / weekly / monthly) plus a countdown to each reset. This extension
 * renders the same numbers as a single colored row directly above the editor —
 * next to the status line — so they are always visible without running `/usage`.
 *
 * It is fully data-driven: every provider, account, and meter that
 * `ctx.modelRegistry.authStorage.usage.reports(...)` returns is rendered,
 * whatever it is (Claude, Codex, Gemini, Grok/xAI, OpenCode, Cursor, Copilot,
 * Kimi, Z.ai, …). Providers with no usage backend simply never appear in the
 * reports, so they are skipped. This is the exact call `AgentSession` makes for
 * `/usage` and the built-in footer; unlike the built-in `usage` segment (active
 * provider only), this shows every reported subscription. A model-specific quota
 * (a limit with a `scope.tier`, such as Codex Spark or Claude's Opus-only weekly)
 * renders as its own entry instead of sharing the account-wide row. See
 * `selectMeters`.
 *
 * Rendering uses a component widget (`ui.setWidget(..., { placement: "aboveEditor" })`)
 * rather than `ui.setStatus`, which feeds the hook-status block and renders apart
 * from the main line with its own spacing. A component row renders flush above
 * the editor and can carry theme colors. Network fetches are cached for
 * `NETWORK_TTL_MS`; a per-minute timer requests a redraw so the countdown ticks
 * locally from the cached absolute reset timestamps without refetching. The
 * widget is cleared on session shutdown and stays idle where `ctx.hasUI` is false.
 *
 * In Tern, omp describes components through the Tern Surface Protocol instead of
 * drawing rows. Without a `describe` method the row would fall back to a fixed-
 * width `rows` block in the terminal's own glyphs, so `UsageRow.describe` hands
 * Tern native nodes it lays out and wraps itself: each window gets a `meter` bar,
 * and hovering the row opens a card with every window's share left and reset time.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const WIDGET_KEY = "usage-status";
/** Refetch from the provider at most this often (matches core's footer cache). */
const NETWORK_TTL_MS = 5 * 60_000;
/** Local redraw cadence: recomputes the reset countdown from cached data. */
const TICK_MS = 60_000;
/** Abort a single usage fetch after this long. */
const FETCH_TIMEOUT_MS = 10_000;

/** Short display names for common providers; unknown ids are title-cased. */
const KNOWN_LABELS: Record<string, string> = {
  anthropic: "Claude",
  "openai-codex": "Codex",
  "openai-codex-device": "Codex",
  "github-copilot": "Copilot",
  cursor: "Cursor",
  "google-antigravity": "Antigravity",
  "google-gemini-cli": "Gemini",
  gemini: "Gemini",
  "kimi-code": "Kimi",
  kimi: "Kimi",
  minimax: "MiniMax",
  "minimax-code": "MiniMax",
  "minimax-code-cn": "MiniMax",
  ollama: "Ollama",
  "ollama-cloud": "Ollama",
  "opencode-go": "OpenCode",
  "opencode-zen": "OpenCode Zen",
  xai: "Grok",
  "xai-oauth": "Grok",
  zai: "Z.ai",
  zenmux: "ZenMux",
};

/** Compact tokens for word-form window ids that carry no duration. */
const WINDOW_WORDS: Record<string, string> = {
  hourly: "1h",
  daily: "1d",
  weekly: "7d",
  monthly: "30d",
};

/** Structural subset of pi-ai's `UsageLimit` that this formatter reads. */
export interface UsageLimitLike {
  scope: { windowId?: string; tier?: string };
  window?: {
    id?: string;
    label?: string;
    durationMs?: number;
    resetsAt?: number;
  };
  amount: { usedFraction?: number; remainingFraction?: number };
}

/** Structural subset of pi-ai's `UsageReport` that this formatter reads. */
export interface UsageReportLike {
  provider: string;
  limits: UsageLimitLike[];
  metadata?: Record<string, unknown>;
}

/** Styling seam so the formatter stays pure and testable. `fg` wraps text in a
 *  theme color (identity in no-color contexts); `dot`/`pipe` are the separators. */
export interface RowStyle {
  fg: (color: string, text: string) => string;
  dot: string;
  pipe: string;
  showReset: boolean;
}

const plainFg = (_color: string, text: string): string => text;
const PLAIN_STYLE: RowStyle = {
  fg: plainFg,
  dot: " · ",
  pipe: "  |  ",
  showReset: true,
};

/** Friendly display name for a provider id — curated brand, else title-cased.
 *  Also used for meter tier ids ("spark" → "Spark", "fable" → "Fable"), so both
 *  halves of a row label go through one display-name path. */
export function providerLabel(provider: string): string {
  const known = KNOWN_LABELS[provider];
  if (known) return known;
  return provider
    .split(/[-_]/u)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Round a duration to a compact single-unit token: "45m", "5h", "7d", "30d". */
function durationToken(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Compact window token, preferring the reported duration, then id/label. */
export function windowToken(limit: UsageLimitLike): string {
  const duration = limit.window?.durationMs;
  if (typeof duration === "number" && duration > 0) return durationToken(duration);
  const id = (limit.scope.windowId ?? limit.window?.id ?? "")
    .toLowerCase()
    .replace(/^rolling-/u, "");
  if (/^\d+(m|h|d|w|mo)$/u.test(id)) return id;
  return WINDOW_WORDS[id] ?? (id || limit.window?.label || "?");
}

/** Remaining availability as an integer percent (0-100), or undefined. */
export function remainingPercent(limit: UsageLimitLike): number | undefined {
  const amount = limit?.amount;
  if (!amount) return undefined;
  const fraction =
    amount.remainingFraction ??
    (amount.usedFraction === undefined ? undefined : 1 - amount.usedFraction);
  if (fraction === undefined) return undefined;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** Theme color, and meter tone, for a remaining share. */
export type UsageTone = "success" | "warning" | "error";

/** Theme color for a remaining-percent value: green plenty, yellow low, red critical. */
export function usageColor(remaining: number): UsageTone {
  if (remaining <= 20) return "error";
  if (remaining <= 50) return "warning";
  return "success";
}

/** Compact reset countdown, rounded up so it never understates: "47m", "2h13m", "6d23h58m". */
export function formatReset(ms: number): string {
  const totalMinutes = Math.ceil(Math.max(0, ms) / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}`;
  if (hours > 0) return `${hours}h${minutes ? `${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

interface Meter {
  /** `scope.tier`, or "" for the base (untiered) meter. */
  tier: string;
  windows: UsageLimitLike[];
}

/** Split a report's limits into meters: the base (untiered) quota plus one per
 *  `scope.tier`. A tier is a separate model-specific quota — Codex Spark's 5h/7d,
 *  Claude's Opus-only ("fable") 7d — so it gets its own row entry rather than
 *  competing for a shared per-window slot. Folding them together let Spark's 5h
 *  masquerade as the account's session window on a Codex plan that reports no 5h
 *  chat limit at all, and hid the Opus weekly behind the overall weekly. Grouping is
 *  purely by reported shape, so a provider adding, renaming, or dropping a meter is
 *  picked up on the next fetch with no per-provider table to maintain. Windows with
 *  no resolvable remaining % are dropped, each window appears once per meter, and
 *  windows are ordered shortest-first. */
function selectMeters(limits: readonly UsageLimitLike[]): Meter[] {
  const byTier = new Map<string, Map<string, UsageLimitLike>>();
  for (const limit of limits) {
    if (remainingPercent(limit) === undefined) continue;
    const tier = limit.scope.tier ?? "";
    let windows = byTier.get(tier);
    if (!windows) {
      windows = new Map();
      byTier.set(tier, windows);
    }
    const key =
      limit.scope.windowId ?? limit.window?.id ?? limit.window?.label ?? windowToken(limit);
    if (!windows.has(key)) windows.set(key, limit);
  }
  return [...byTier].map(([tier, windows]) => ({
    tier,
    windows: [...windows.values()].toSorted(
      (a, b) =>
        (a.window?.durationMs ?? Number.POSITIVE_INFINITY) -
        (b.window?.durationMs ?? Number.POSITIVE_INFINITY),
    ),
  }));
}

/** Short account label from report metadata (email local-part, id, or project). */
function accountLabel(report: UsageReportLike): string {
  const meta = report.metadata ?? {};
  const email = typeof meta["email"] === "string" ? meta["email"] : "";
  if (email) return email.split("@")[0] || email;
  const accountId = typeof meta["accountId"] === "string" ? meta["accountId"] : "";
  if (accountId) return accountId;
  const projectId = typeof meta["projectId"] === "string" ? meta["projectId"] : "";
  return projectId || "acct";
}

/** One styled run of text: `s` is a theme color token (`accent`, `success`,
 *  `dim`, …), absent for plain text. The same shape as a Tern Surface Protocol
 *  span, so a run feeds both the ANSI row and the native description. */
export interface UsageSpan {
  t: string;
  s?: string;
}

/** One labeled entry on the row: a provider (account, tier) and its windows.
 *  `base` is the provider (and account) label, `tier` the meter's label or "". */
interface UsageEntry {
  label: string;
  base: string;
  tier: string;
  windows: UsageLimitLike[];
}

/** One window as "<token> <pct>%[ (<reset>)]", with color on the values. */
function windowSpans(limit: UsageLimitLike, now: number, showReset: boolean): UsageSpan[] {
  const remaining = remainingPercent(limit) ?? 0;
  const spans: UsageSpan[] = [
    { t: `${windowToken(limit)} ` },
    { t: `${remaining}%`, s: usageColor(remaining) },
  ];
  const resetsAt = limit.window?.resetsAt;
  if (showReset && typeof resetsAt === "number" && resetsAt > now) {
    spans.push({ t: " " }, { t: `(${formatReset(resetsAt - now)})`, s: "dim" });
  }
  return spans;
}

/** One entry as its accent label followed by its windows joined by `dot`. */
function entrySpans(
  entry: UsageEntry,
  now: number,
  showReset: boolean,
  dot: UsageSpan,
): UsageSpan[] {
  const spans: UsageSpan[] = [{ t: entry.label, s: "accent" }, { t: " " }];
  for (const [index, window] of entry.windows.entries()) {
    if (index > 0) spans.push(dot);
    spans.push(...windowSpans(window, now, showReset));
  }
  return spans;
}

/** Absent, or a string. */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Absent, or a finite number. */
function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

/** Runtime guard for a well-formed limit: network data is cast, not validated, so
 *  a malformed entry — including wrong-typed nested fields that would crash string
 *  or number ops in `windowToken`/`formatWindow` — must be dropped before render. */
function isUsageLimit(value: unknown): value is UsageLimitLike {
  if (typeof value !== "object" || value === null) return false;
  const { amount, scope, window } = value as UsageLimitLike;
  if (typeof amount !== "object" || amount === null) return false;
  if (!optionalFiniteNumber(amount.remainingFraction)) return false;
  if (!optionalFiniteNumber(amount.usedFraction)) return false;
  if (typeof scope !== "object" || scope === null) return false;
  if (!optionalString(scope.windowId) || !optionalString(scope.tier)) return false;
  if (window === undefined) return true;
  if (typeof window !== "object" || window === null) return false;
  if (!optionalString(window.id) || !optionalString(window.label)) return false;
  return optionalFiniteNumber(window.durationMs) && optionalFiniteNumber(window.resetsAt);
}

/** Validate raw usage data before it is treated as `UsageReportLike[]`: keep only
 *  report objects with a string provider and array limits, and drop malformed
 *  limits, so nothing unsafe reaches `render()`. Network data is cast, not typed. */
function sanitizeUsageReports(value: unknown): UsageReportLike[] {
  if (!Array.isArray(value)) return [];
  const reports: UsageReportLike[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const report = entry as UsageReportLike;
    if (typeof report.provider !== "string" || !Array.isArray(report.limits)) continue;
    reports.push({ ...report, limits: report.limits.filter(isUsageLimit) });
  }
  return reports;
}

/** Every reported subscription as labeled entries, sorted by label. */
function usageEntries(reports: readonly UsageReportLike[]): UsageEntry[] {
  const valid = reports.filter(
    (r): r is UsageReportLike => !!r && typeof r.provider === "string" && Array.isArray(r.limits),
  );
  const rendered: { report: UsageReportLike; meters: Meter[] }[] = [];
  for (const report of valid) {
    const meters = selectMeters(report.limits);
    if (meters.length > 0) rendered.push({ report, meters });
  }
  const counts = new Map<string, number>();
  for (const { report } of rendered)
    counts.set(report.provider, (counts.get(report.provider) ?? 0) + 1);

  const entries = rendered.flatMap(({ report, meters }) => {
    const brand = providerLabel(report.provider);
    // Disambiguate with an account label only when a provider has >1 rendered account.
    const base =
      (counts.get(report.provider) ?? 0) > 1 ? `${brand}:${accountLabel(report)}` : brand;
    return meters.map((meter) => {
      const tier = meter.tier ? providerLabel(meter.tier) : "";
      return { label: tier ? `${base} ${tier}` : base, base, tier, windows: meter.windows };
    });
  });
  return entries.toSorted((a, b) => a.label.localeCompare(b.label));
}

/** Build the usage row from every reported subscription, or undefined when empty. */
export function formatUsageStatus(
  reports: readonly UsageReportLike[],
  now: number,
  style: RowStyle = PLAIN_STYLE,
): string | undefined {
  const entries = usageEntries(reports);
  if (entries.length === 0) return undefined;
  return entries
    .map((entry) =>
      entrySpans(entry, now, style.showReset, { t: style.dot })
        .map((span) => (span.s ? style.fg(span.s, span.t) : span.t))
        .join(""),
    )
    .join(style.pipe);
}

type CharExtent = `${number}ch`;

/** The structural subset of pi-tui's `NativeNode` (Tern Surface Protocol) this
 *  widget describes. The hover card is the same shape, as a `TspPropNode`. */
export type UsageNode =
  | {
      k: "row";
      key?: string;
      p: {
        gap: "xs" | "sm" | "lg";
        wrap?: true;
        align?: "center";
        justify?: "between";
        hovercard?: UsageNode;
      };
      c: UsageNode[];
    }
  | { k: "col"; key?: string; p: { gap?: "xs" | "sm" | "md"; hidden?: true }; c?: UsageNode[] }
  | { k: "text"; key?: string; p: { spans: UsageSpan[]; wrap: "none" } }
  | {
      k: "meter";
      key?: string;
      p: {
        value: number;
        style: "bar";
        size: "sm";
        tone: UsageTone;
        grow?: number;
        min?: { w: CharExtent };
        max?: { w: CharExtent };
      };
    };

/** What the description needs from omp's `DescribeContext`. */
export interface UsageDescribeOptions {
  /** The terminal draws `meter` nodes; without them the row stays text only. */
  meters: boolean;
  /** The user's clock reads 12-hour; undefined leaves it to the locale. */
  hour12?: boolean | undefined;
  /** Pane width in cells: the row compacts until its estimate fits. */
  cols: number;
}

const HIDDEN_NODE: UsageNode = { k: "col", p: { hidden: true } };
/** Width of an inline window bar, in cells. */
const INLINE_METER_CELLS = 8;
const INLINE_METER: CharExtent = `${INLINE_METER_CELLS}ch`;
/** Estimated cells for the gaps between pieces of a provider and between providers. */
const PIECE_GAP_CELLS = 1;
const GROUP_GAP_CELLS = 3;
const CARD_WINDOW_NAMES: Record<string, string> = {
  "1d": "Daily",
  "7d": "Weekly",
  "30d": "Monthly",
};

function textNode(spans: UsageSpan[]): UsageNode {
  return { k: "text", p: { spans, wrap: "none" } };
}

/** Remaining share as a bar, toned like its percent. */
function meterNode(remaining: number, inline: boolean): UsageNode {
  const base = {
    value: remaining / 100,
    style: "bar",
    size: "sm",
    tone: usageColor(remaining),
  } as const;
  return {
    k: "meter",
    p: inline
      ? { ...base, min: { w: INLINE_METER }, max: { w: INLINE_METER } }
      : { ...base, grow: 1 },
  };
}

/** A window's name in the card: "5-hour window", "Weekly window". */
function windowName(limit: UsageLimitLike): string {
  const token = windowToken(limit);
  const hours = /^(\d+)h$/u.exec(token)?.[1];
  return `${CARD_WINDOW_NAMES[token] ?? (hours ? `${hours}-hour` : token)} window`;
}

/** Local clock time of a reset: the time today, else weekday and time within a
 *  week, else the date as well. */
function resetClock(resetsAt: number, now: number, hour12: boolean | undefined): string {
  const at = new Date(resetsAt);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const withinWeek = resetsAt - now < 6 * 24 * 60 * 60_000;
  return at.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    ...(withinWeek ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
    ...(hour12 === undefined ? {} : { hour12 }),
  });
}

/** A window on the row with the meter it belongs to ("" for the base meter). */
interface RowWindow {
  tier: string;
  limit: UsageLimitLike;
}

/** One provider (account) on the row, its tiered meters folded in. */
interface RowGroup {
  label: string;
  windows: RowWindow[];
}

/** How much each window shows: `full` with countdowns, `brief` without, and
 *  `lowest` only the window with the least left per provider. */
type RowLevel = "full" | "brief" | "lowest";
const ROW_LEVELS: readonly RowLevel[] = ["full", "brief", "lowest"];

/** Fold each provider's tiered entries (Claude Fable) into its base entry. */
function rowGroups(entries: readonly UsageEntry[]): RowGroup[] {
  const groups = new Map<string, RowWindow[]>();
  for (const entry of entries) {
    const windows = groups.get(entry.base) ?? [];
    windows.push(...entry.windows.map((limit) => ({ tier: entry.tier, limit })));
    groups.set(entry.base, windows);
  }
  return [...groups].map(([label, windows]) => ({ label, windows }));
}

/** The window with the least left; the first (base, shortest) wins a tie. */
function lowestWindow(windows: readonly RowWindow[]): RowWindow[] {
  const percent = (window: RowWindow) => remainingPercent(window.limit) ?? 0;
  return [windows.reduce((low, window) => (percent(window) < percent(low) ? window : low))];
}

/** One window inline: token (tier-prefixed), bar, percent and countdown. */
function inlineWindow(
  window: RowWindow,
  now: number,
  meters: boolean,
  showReset: boolean,
): UsageNode[] {
  const remaining = remainingPercent(window.limit) ?? 0;
  const [token, ...rest] = windowSpans(window.limit, now, showReset);
  const label = `${window.tier ? `${window.tier} ` : ""}${token?.t ?? ""}`;
  if (!meters) return [textNode([{ t: label }, ...rest])];
  return [textNode([{ t: label.trimEnd() }]), meterNode(remaining, true), textNode(rest)];
}

/** One provider's pieces: accent label, then its windows split by a dimmed `dot`. */
function inlineGroup(
  group: RowGroup,
  level: RowLevel,
  now: number,
  dot: string,
  meters: boolean,
): UsageNode[] {
  const pieces: UsageNode[] = [textNode([{ t: group.label, s: "accent" }])];
  const windows = level === "lowest" ? lowestWindow(group.windows) : group.windows;
  for (const [index, window] of windows.entries()) {
    if (index > 0) pieces.push(textNode([{ t: dot.trim(), s: "dim" }]));
    pieces.push(...inlineWindow(window, now, meters, level === "full"));
  }
  return pieces;
}

/** Estimated cells of one provider's pieces. Tern draws the row in a
 *  proportional font, so counting characters as cells errs on the wide side. */
function piecesCells(pieces: readonly UsageNode[]): number {
  let cells = (pieces.length - 1) * PIECE_GAP_CELLS;
  for (const piece of pieces) {
    cells +=
      piece.k === "text"
        ? piece.p.spans.reduce((sum, span) => sum + [...span.t].length, 0)
        : INLINE_METER_CELLS;
  }
  return cells;
}

/** The row's providers at the fullest level whose estimate fits `cols`, else
 *  at the most compact level (the row then wraps). */
function fittedGroups(
  groups: readonly RowGroup[],
  now: number,
  dot: string,
  options: UsageDescribeOptions,
): UsageNode[] {
  let fitted: UsageNode[] = [];
  for (const level of ROW_LEVELS) {
    const pieces = groups.map((group) => inlineGroup(group, level, now, dot, options.meters));
    fitted = pieces.map((c, index) => ({
      k: "row",
      key: groups[index]?.label ?? "",
      p: { gap: "sm", align: "center" },
      c,
    }));
    const cells =
      pieces.reduce((sum, group) => sum + piecesCells(group), 0) +
      (groups.length - 1) * GROUP_GAP_CELLS;
    if (cells <= options.cols) break;
  }
  return fitted;
}

/** One window in the card: name and share left, a full-width bar, the reset. */
function cardWindow(limit: UsageLimitLike, now: number, options: UsageDescribeOptions): UsageNode {
  const remaining = remainingPercent(limit) ?? 0;
  const children: UsageNode[] = [
    {
      k: "row",
      p: { gap: "sm", justify: "between" },
      c: [
        textNode([{ t: windowName(limit) }]),
        textNode([
          { t: `${remaining}%`, s: usageColor(remaining) },
          { t: " left", s: "dim" },
        ]),
      ],
    },
  ];
  if (options.meters) children.push(meterNode(remaining, false));
  const resetsAt = limit.window?.resetsAt;
  if (typeof resetsAt === "number" && resetsAt > now) {
    const clock = resetClock(resetsAt, now, options.hour12);
    children.push(
      textNode([{ t: `resets in ${formatReset(resetsAt - now)} · ${clock}`, s: "dim" }]),
    );
  }
  return { k: "col", key: windowToken(limit), p: { gap: "xs" }, c: children };
}

/** The hover card: every entry with each window's bar, share left and reset time. */
function usageCard(entries: UsageEntry[], now: number, options: UsageDescribeOptions): UsageNode {
  return {
    k: "col",
    p: { gap: "md" },
    c: [
      textNode([{ t: "Usage", s: "strong" }]),
      ...entries.map((entry): UsageNode => ({
        k: "col",
        key: entry.label,
        p: { gap: "sm" },
        c: [
          textNode([{ t: entry.label, s: "accent" }]),
          ...entry.windows.map((window) => cardWindow(window, now, options)),
        ],
      })),
    ],
  };
}

/** Native description for Tern: a wrapping row with one keyed entry per
 *  provider (tiered meters folded in), so a narrow pane moves whole providers to
 *  the next line and the terminal's gap replaces the pipe separator. Each window
 *  gets a bar where the terminal draws meters. When the row would not fit on
 *  one line it drops the countdowns, then shows only each provider's lowest
 *  window; hovering it opens a card with every window's details. */
export function describeUsageStatus(
  reports: readonly UsageReportLike[],
  now: number,
  dot: string,
  options: UsageDescribeOptions,
): UsageNode {
  const entries = usageEntries(reports);
  if (entries.length === 0) return HIDDEN_NODE;
  return {
    k: "row",
    p: { gap: "lg", wrap: true, hovercard: usageCard(entries, now, options) },
    c: fittedGroups(rowGroups(entries), now, dot, options),
  };
}

interface ThemeLike {
  fg(color: string, text: string): string;
  sep: { dot: string; pipe: string };
}

const EMPTY_ROWS: readonly string[] = [];

/** One-line widget component rendered above the editor. Reads `reports` live so
 *  a redraw recomputes the countdown from the cached absolute reset times. In a
 *  Tern Surface Protocol terminal omp calls `describe` instead of `render`. */
class UsageRow {
  reports: readonly UsageReportLike[] = [];
  readonly #fg: (color: string, text: string) => string;
  readonly #dot: string;
  readonly #pipe: string;
  #native: { signature: string; node: UsageNode } | undefined;

  constructor(theme: ThemeLike) {
    this.#fg = (color, text) => theme.fg(color, text);
    this.#dot = theme.sep.dot;
    this.#pipe = `  ${theme.sep.pipe}  `;
  }

  render(width: number): readonly string[] {
    const now = Date.now();
    // Drop the reset countdowns before hiding entirely; measure the uncolored
    // form so ANSI color codes never count against the width budget.
    for (const showReset of [true, false] as const) {
      const base = { dot: this.#dot, pipe: this.#pipe, showReset };
      const plain = formatUsageStatus(this.reports, now, {
        ...base,
        fg: plainFg,
      });
      if (!plain) return EMPTY_ROWS;
      if ([...plain].length <= width) {
        return [formatUsageStatus(this.reports, now, { ...base, fg: this.#fg }) ?? plain];
      }
    }
    return EMPTY_ROWS;
  }

  /** Native node; the same object is returned while the description is
   *  unchanged, which is how the reconciler skips an unchanged component. */
  describe(cx: { cols: number; supports(kind: "meter"): boolean; hour12?: boolean }): UsageNode {
    const node = describeUsageStatus(this.reports, Date.now(), this.#dot, {
      meters: cx.supports("meter"),
      hour12: cx.hour12,
      cols: cx.cols,
    });
    const signature = JSON.stringify(node);
    if (this.#native?.signature !== signature) this.#native = { signature, node };
    return this.#native.node;
  }
}

interface UsageState {
  reports: UsageReportLike[];
  fetchedAt: number;
  inFlight: boolean;
  /** Bumped on every teardown; a fetch whose captured value no longer matches
   *  has been superseded by a session switch and must not touch state. */
  generation: number;
  timer: Timer | undefined;
  ctx: ExtensionContext | undefined;
  component: UsageRow | undefined;
  tui: { requestRender?: (force?: boolean) => void } | undefined;
}

function redraw(state: UsageState): void {
  if (state.component) state.component.reports = state.reports;
  state.tui?.requestRender?.();
}

function installWidget(state: UsageState, ctx: ExtensionContext): void {
  try {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        state.tui = tui;
        if (!state.component) state.component = new UsageRow(theme);
        state.component.reports = state.reports;
        return state.component;
      },
      { placement: "aboveEditor" },
    );
  } catch {
    // ACP/RPC hosts may not support component widgets; the row is optional.
  }
}

function clearWidget(state: UsageState): void {
  const ctx = state.ctx;
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
  } catch {
    // Nothing to clear on hosts that ignored the widget.
  }
}

async function fetchReports(state: UsageState): Promise<void> {
  const registry = state.ctx?.modelRegistry;
  const usage = registry?.authStorage?.usage;
  if (!registry || state.inFlight || typeof usage?.reports !== "function") return;
  const generation = state.generation;
  state.inFlight = true;
  try {
    const result = await usage.reports({
      baseUrlResolver: (provider) => registry.getProviderBaseUrl(provider),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Superseded by a session switch.
    if (generation !== state.generation) return;
    state.reports = sanitizeUsageReports(result);
    state.fetchedAt = Date.now();
  } catch {
    // Keep the stale cache — the countdown still ticks from cached reset times.
  } finally {
    if (generation === state.generation) state.inFlight = false;
  }
  if (generation === state.generation) redraw(state);
}

function tick(state: UsageState): void {
  if (Date.now() - state.fetchedAt >= NETWORK_TTL_MS) void fetchReports(state);
  else redraw(state);
}

function stop(state: UsageState): void {
  clearInterval(state.timer);
  state.timer = undefined;
  clearWidget(state);
  state.component = undefined;
  state.tui = undefined;
  // Invalidate any in-flight fetch and free the slot for the next session.
  state.generation += 1;
  state.inFlight = false;
}

function start(state: UsageState, ctx: ExtensionContext): void {
  state.ctx = ctx;
  clearInterval(state.timer);
  state.timer = undefined;
  if (!ctx.hasUI) return;
  installWidget(state, ctx);
  void fetchReports(state);
  state.timer = setInterval(() => tick(state), TICK_MS);
  state.timer.unref?.();
}

export default function usageStatus(pi: ExtensionAPI): void {
  const state: UsageState = {
    reports: [],
    fetchedAt: 0,
    inFlight: false,
    generation: 0,
    timer: undefined,
    ctx: undefined,
    component: undefined,
    tui: undefined,
  };
  pi.on("session_start", (_event, ctx) => start(state, ctx));
  pi.on("session_switch", (_event, ctx) => {
    stop(state);
    state.reports = [];
    state.fetchedAt = 0;
    start(state, ctx);
  });
  pi.on("session_shutdown", () => stop(state));
}
