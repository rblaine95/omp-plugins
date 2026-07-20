/**
 * usage-status — surface remaining subscription usage above the omp editor.
 *
 * `/usage` reports how much quota is left per subscription (rolling windows like
 * 5h / 7d / weekly / monthly) plus a countdown to each reset. This extension
 * renders the same numbers as a single colored row directly above the editor —
 * next to the status line — so they are always visible without running `/usage`.
 *
 * It is fully data-driven: every provider and account that
 * `ctx.modelRegistry.authStorage.fetchUsageReports(...)` returns is rendered,
 * whatever it is (Claude, Codex, Gemini, Grok/xAI, OpenCode, Cursor, Copilot,
 * Kimi, Z.ai, …). Providers with no usage backend simply never appear in the
 * reports, so they are skipped. This is the exact call `AgentSession` makes for
 * `/usage` and the built-in footer; unlike the built-in `usage` segment (active
 * provider only), this shows every reported subscription.
 *
 * Rendering uses a component widget (`ui.setWidget(..., { placement: "aboveEditor" })`)
 * rather than `ui.setStatus`, which feeds the hook-status block and renders apart
 * from the main line with its own spacing. A component row renders flush above
 * the editor and can carry theme colors. Network fetches are cached for
 * `NETWORK_TTL_MS`; a per-minute timer requests a redraw so the countdown ticks
 * locally from the cached absolute reset timestamps without refetching. The
 * widget is cleared on session shutdown and stays idle where `ctx.hasUI` is false.
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

/** Friendly provider label: curated brand, else title-cased id. */
export function providerLabel(provider: string): string {
  const known = KNOWN_LABELS[provider];
  if (known) return known;
  return provider
    .split(/[-_]/)
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
  if (typeof duration === "number" && duration > 0)
    return durationToken(duration);
  const id = (limit.scope.windowId ?? limit.window?.id ?? "")
    .toLowerCase()
    .replace(/^rolling-/, "");
  if (/^\d+(m|h|d|w|mo)$/.test(id)) return id;
  return WINDOW_WORDS[id] ?? (id || limit.window?.label || "?");
}

/** Remaining availability as an integer percent (0-100), or undefined. */
export function remainingPercent(limit: UsageLimitLike): number | undefined {
  const amount = limit?.amount;
  if (!amount) return undefined;
  const fraction =
    amount.remainingFraction ??
    (amount.usedFraction !== undefined ? 1 - amount.usedFraction : undefined);
  if (fraction === undefined) return undefined;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** Theme color for a remaining-percent value: green plenty, yellow low, red critical. */
export function usageColor(remaining: number): string {
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
  if (days > 0)
    return `${days}d${hours ? `${hours}h` : ""}${minutes ? `${minutes}m` : ""}`;
  if (hours > 0) return `${hours}h${minutes ? `${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

/** A single report's windows: one per window id, preferring an untiered limit,
 *  dropping windows with no resolvable remaining %, sorted shortest-first. */
function selectWindows(limits: readonly UsageLimitLike[]): UsageLimitLike[] {
  const byKey = new Map<string, UsageLimitLike>();
  for (const limit of limits) {
    if (remainingPercent(limit) === undefined) continue;
    const key =
      limit.scope.windowId ??
      limit.window?.id ??
      limit.window?.label ??
      windowToken(limit);
    const existing = byKey.get(key);
    if (!existing || (existing.scope.tier && !limit.scope.tier))
      byKey.set(key, limit);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      (a.window?.durationMs ?? Number.POSITIVE_INFINITY) -
      (b.window?.durationMs ?? Number.POSITIVE_INFINITY),
  );
}

/** Short account label from report metadata (email local-part, id, or project). */
function accountLabel(report: UsageReportLike): string {
  const meta = report.metadata ?? {};
  const email = typeof meta["email"] === "string" ? meta["email"] : "";
  if (email) return email.split("@")[0] || email;
  const accountId =
    typeof meta["accountId"] === "string" ? meta["accountId"] : "";
  if (accountId) return accountId;
  const projectId =
    typeof meta["projectId"] === "string" ? meta["projectId"] : "";
  return projectId || "acct";
}

/** Render one window as "<token> <pct>%[ (<reset>)]", with color on the values. */
function formatWindow(
  limit: UsageLimitLike,
  now: number,
  style: RowStyle,
): string {
  const remaining = remainingPercent(limit) ?? 0;
  const pct = style.fg(usageColor(remaining), `${remaining}%`);
  const resetsAt = limit.window?.resetsAt;
  const reset =
    style.showReset && typeof resetsAt === "number" && resetsAt > now
      ? ` ${style.fg("dim", `(${formatReset(resetsAt - now)})`)}`
      : "";
  return `${windowToken(limit)} ${pct}${reset}`;
}

/** Runtime guard for a well-formed limit: network data is cast, not validated,
 *  so a malformed entry must be dropped before it reaches `render()`. */
function isUsageLimit(value: unknown): value is UsageLimitLike {
  if (typeof value !== "object" || value === null) return false;
  const limit = value as UsageLimitLike;
  return (
    typeof limit.amount === "object" &&
    limit.amount !== null &&
    typeof limit.scope === "object" &&
    limit.scope !== null
  );
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
    if (typeof report.provider !== "string" || !Array.isArray(report.limits))
      continue;
    reports.push({ ...report, limits: report.limits.filter(isUsageLimit) });
  }
  return reports;
}

/** Build the usage row from every reported subscription, or undefined when empty. */
export function formatUsageStatus(
  reports: readonly UsageReportLike[],
  now: number,
  style: RowStyle = PLAIN_STYLE,
): string | undefined {
  const valid = reports.filter(
    (r): r is UsageReportLike =>
      !!r && typeof r.provider === "string" && Array.isArray(r.limits),
  );
  const counts = new Map<string, number>();
  for (const report of valid)
    counts.set(report.provider, (counts.get(report.provider) ?? 0) + 1);

  const entries: { label: string; windows: UsageLimitLike[] }[] = [];
  for (const report of valid) {
    const windows = selectWindows(report.limits);
    if (windows.length === 0) continue;
    const base = providerLabel(report.provider);
    // Disambiguate with an account label only when a provider has >1 account.
    const label =
      (counts.get(report.provider) ?? 0) > 1
        ? `${base}:${accountLabel(report)}`
        : base;
    entries.push({ label, windows });
  }
  entries.sort((a, b) => a.label.localeCompare(b.label));

  const parts = entries.map(
    (entry) =>
      `${style.fg("accent", entry.label)} ${entry.windows
        .map((window) => formatWindow(window, now, style))
        .join(style.dot)}`,
  );
  return parts.length ? parts.join(style.pipe) : undefined;
}

interface ThemeLike {
  fg(color: string, text: string): string;
  sep: { dot: string; pipe: string };
}

const EMPTY_ROWS: readonly string[] = [];

/** One-line widget component rendered above the editor. Reads `reports` live so
 *  a redraw recomputes the countdown from the cached absolute reset times. */
class UsageRow {
  reports: readonly UsageReportLike[] = [];
  readonly #fg: (color: string, text: string) => string;
  readonly #dot: string;
  readonly #pipe: string;

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
        return [
          formatUsageStatus(this.reports, now, { ...base, fg: this.#fg }) ??
            plain,
        ];
      }
    }
    return EMPTY_ROWS;
  }
}

interface UsageState {
  reports: UsageReportLike[];
  fetchedAt: number;
  inFlight: boolean;
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
  const authStorage = registry?.authStorage;
  if (
    !registry ||
    state.inFlight ||
    typeof authStorage?.fetchUsageReports !== "function"
  )
    return;
  state.inFlight = true;
  try {
    const result = await authStorage.fetchUsageReports({
      baseUrlResolver: (provider) => registry.getProviderBaseUrl(provider),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    state.reports = sanitizeUsageReports(result);
    state.fetchedAt = Date.now();
  } catch {
    // Keep the stale cache — the countdown still ticks from cached reset times.
  } finally {
    state.inFlight = false;
  }
  redraw(state);
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
    timer: undefined,
    ctx: undefined,
    component: undefined,
    tui: undefined,
  };
  pi.on("session_start", (_event, ctx) => start(state, ctx));
  pi.on("session_switch", (_event, ctx) => {
    state.reports = [];
    state.fetchedAt = 0;
    state.component = undefined;
    start(state, ctx);
  });
  pi.on("session_shutdown", () => stop(state));
}
