import { describe, expect, jest, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import usageStatus, {
  formatReset,
  formatUsageStatus,
  providerLabel,
  type RowStyle,
  remainingPercent,
  type UsageReportLike,
  usageColor,
  windowToken,
} from "./index";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

function limit(opts: {
  windowId?: string;
  windowIdField?: string;
  windowLabel?: string;
  durationMs?: number;
  resetsAt?: number;
  tier?: string;
  usedFraction?: number;
  remainingFraction?: number;
}): UsageReportLike["limits"][number] {
  return {
    scope: { windowId: opts.windowId, tier: opts.tier },
    window: {
      id: opts.windowIdField,
      label: opts.windowLabel,
      durationMs: opts.durationMs,
      resetsAt: opts.resetsAt,
    },
    amount: {
      usedFraction: opts.usedFraction,
      remainingFraction: opts.remainingFraction,
    },
  };
}

describe("formatReset", () => {
  test("renders minutes under an hour", () => {
    expect(formatReset(47 * MIN)).toBe("47m");
  });
  test("renders hours and minutes", () => {
    expect(formatReset(133 * MIN)).toBe("2h13m");
  });
  test("renders days, hours, and minutes together", () => {
    expect(formatReset(6 * DAY + 23 * HR + 58 * MIN)).toBe("6d23h58m");
  });
  test("rounds partial minutes up and floors at <1m", () => {
    expect(formatReset(30_000)).toBe("1m");
    expect(formatReset(0)).toBe("<1m");
    expect(formatReset(-1000)).toBe("<1m");
  });
});

describe("providerLabel", () => {
  test("uses curated brands for known providers", () => {
    expect(providerLabel("anthropic")).toBe("Claude");
    expect(providerLabel("openai-codex")).toBe("Codex");
    expect(providerLabel("xai")).toBe("Grok");
    expect(providerLabel("opencode-zen")).toBe("OpenCode Zen");
  });
  test("title-cases unknown provider ids", () => {
    expect(providerLabel("some-new-provider")).toBe("Some New Provider");
    expect(providerLabel("wafer")).toBe("Wafer");
  });
});

describe("windowToken", () => {
  test("derives a single-unit token from duration", () => {
    expect(windowToken(limit({ durationMs: 5 * HR }))).toBe("5h");
    expect(windowToken(limit({ durationMs: 7 * DAY }))).toBe("7d");
    expect(windowToken(limit({ durationMs: 30 * DAY }))).toBe("30d");
    expect(windowToken(limit({ durationMs: 45 * MIN }))).toBe("45m");
  });
  test("falls back to numeric ids and word forms without a duration", () => {
    expect(windowToken(limit({ windowId: "5h" }))).toBe("5h");
    expect(windowToken(limit({ windowIdField: "rolling-5h" }))).toBe("5h");
    expect(windowToken(limit({ windowIdField: "weekly" }))).toBe("7d");
    expect(windowToken(limit({ windowIdField: "monthly" }))).toBe("30d");
  });
});

describe("remainingPercent", () => {
  test("prefers remainingFraction, falls back to 1 - usedFraction, clamps", () => {
    expect(
      remainingPercent(limit({ remainingFraction: 0.58, usedFraction: 0.1 })),
    ).toBe(58);
    expect(remainingPercent(limit({ usedFraction: 0.82 }))).toBe(18);
    expect(remainingPercent(limit({ usedFraction: 1.5 }))).toBe(0);
    expect(remainingPercent(limit({ remainingFraction: 1.2 }))).toBe(100);
    expect(remainingPercent(limit({}))).toBeUndefined();
    expect(
      remainingPercent({
        scope: {},
      } as unknown as UsageReportLike["limits"][number]),
    ).toBeUndefined();
  });
});

describe("usageColor", () => {
  test("green when plenty remains, yellow when low, red when critical", () => {
    expect(usageColor(100)).toBe("success");
    expect(usageColor(51)).toBe("success");
    expect(usageColor(50)).toBe("warning");
    expect(usageColor(21)).toBe("warning");
    expect(usageColor(20)).toBe("error");
    expect(usageColor(0)).toBe("error");
  });
});

describe("formatUsageStatus", () => {
  test("empty reports → undefined", () => {
    expect(formatUsageStatus([], NOW)).toBeUndefined();
  });

  test("renders every reported provider and its windows, sorted by label", () => {
    const reports: UsageReportLike[] = [
      {
        provider: "openai-codex",
        limits: [
          limit({
            windowId: "5h",
            usedFraction: 0.08,
            resetsAt: NOW + 47 * MIN,
          }),
          limit({ windowId: "7d", usedFraction: 0.6, resetsAt: NOW + 3 * DAY }),
        ],
      },
      {
        provider: "anthropic",
        limits: [
          limit({
            windowId: "5h",
            remainingFraction: 0.58,
            resetsAt: NOW + 133 * MIN,
          }),
          limit({
            windowId: "7d",
            remainingFraction: 0.82,
            resetsAt: NOW + 5 * DAY,
          }),
        ],
      },
    ];
    expect(formatUsageStatus(reports, NOW)).toBe(
      "Claude 5h 58% (2h13m) · 7d 82% (5d)  |  Codex 5h 92% (47m) · 7d 40% (3d)",
    );
  });
});

describe("formatUsageStatus dynamic providers", () => {
  test("renders arbitrary providers and window shapes dynamically", () => {
    const reports: UsageReportLike[] = [
      {
        provider: "xai",
        limits: [
          limit({
            windowId: "5h",
            remainingFraction: 0.9,
            resetsAt: NOW + 1 * HR,
          }),
        ],
      },
      {
        provider: "opencode-go",
        limits: [
          limit({
            windowIdField: "rolling-5h",
            durationMs: 5 * HR,
            remainingFraction: 0.7,
          }),
          limit({
            windowIdField: "weekly",
            durationMs: 7 * DAY,
            remainingFraction: 0.4,
          }),
          limit({
            windowIdField: "monthly",
            durationMs: 30 * DAY,
            remainingFraction: 0.2,
          }),
        ],
      },
    ];
    expect(formatUsageStatus(reports, NOW)).toBe(
      "Grok 5h 90% (1h)  |  OpenCode 5h 70% · 7d 40% · 30d 20%",
    );
  });
});

describe("formatUsageStatus styling", () => {
  test("applies theme colors to label, percent, and reset", () => {
    const tag: RowStyle = {
      fg: (c, t) => `[${c}]${t}`,
      dot: " · ",
      pipe: " | ",
      showReset: true,
    };
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        limits: [
          limit({
            windowId: "5h",
            remainingFraction: 0.1,
            resetsAt: NOW + 30 * MIN,
          }),
        ],
      },
    ];
    expect(formatUsageStatus(reports, NOW, tag)).toBe(
      "[accent]Claude 5h [error]10% [dim](30m)",
    );
  });
});

describe("formatUsageStatus window selection", () => {
  test("prefers the untiered limit over a tiered duplicate", () => {
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        limits: [
          limit({ windowId: "7d", tier: "fable", remainingFraction: 0.1 }),
          limit({ windowId: "7d", remainingFraction: 0.75 }),
        ],
      },
    ];
    expect(formatUsageStatus(reports, NOW)).toBe("Claude 7d 75%");
  });

  test("omits reset countdown when the window has already reset", () => {
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        limits: [
          limit({
            windowId: "5h",
            remainingFraction: 0.3,
            resetsAt: NOW - 5 * MIN,
          }),
        ],
      },
    ];
    expect(formatUsageStatus(reports, NOW)).toBe("Claude 5h 30%");
  });

  test("skips a report whose windows have no resolvable remaining", () => {
    const reports: UsageReportLike[] = [
      { provider: "cursor", limits: [limit({ windowId: "monthly" })] },
    ];
    expect(formatUsageStatus(reports, NOW)).toBeUndefined();
  });
});

describe("formatUsageStatus multi-account", () => {
  test("labels each account when a provider reports more than one", () => {
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        metadata: { email: "bob@work.com" },
        limits: [limit({ windowId: "5h", remainingFraction: 0.4 })],
      },
      {
        provider: "anthropic",
        metadata: { email: "alice@home.com" },
        limits: [limit({ windowId: "5h", remainingFraction: 0.9 })],
      },
    ];
    expect(formatUsageStatus(reports, NOW)).toBe(
      "Claude:alice 5h 90%  |  Claude:bob 5h 40%",
    );
  });

  test("omits the account label for a single-account provider", () => {
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        metadata: { email: "solo@x.com" },
        limits: [limit({ windowId: "5h", remainingFraction: 0.4 })],
      },
    ];
    expect(formatUsageStatus(reports, NOW)).toBe("Claude 5h 40%");
  });
});

type Handler = (event: unknown, ctx: unknown) => void;
type WidgetFactory = (
  tui: unknown,
  theme: unknown,
) => { render: (width: number) => readonly string[] };

function fakePi(handlers: Record<string, Handler>): ExtensionAPI {
  return {
    on: (ev: string, fn: Handler) => {
      handlers[ev] = fn;
    },
  } as unknown as ExtensionAPI;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

const FAKE_THEME = {
  fg: (_c: string, t: string) => t,
  sep: { dot: " · ", pipe: "|" },
};

interface UiCtxOptions {
  reports: UsageReportLike[];
  widgetCalls: unknown[];
  hasUI?: boolean;
  onFetch?: (opts: {
    baseUrlResolver: (p: string) => string | undefined;
  }) => void;
}

function uiCtx(o: UiCtxOptions): ExtensionContext {
  return {
    hasUI: o.hasUI ?? true,
    ui: { setWidget: (...args: unknown[]) => o.widgetCalls.push(args) },
    modelRegistry: {
      getProviderBaseUrl: (p: string) => `https://api/${p}`,
      authStorage: {
        fetchUsageReports: (opts: {
          baseUrlResolver: (p: string) => string | undefined;
        }) => {
          o.onFetch?.(opts);
          return Promise.resolve(o.reports);
        },
      },
    },
  } as unknown as ExtensionContext;
}

describe("usageStatus wiring", () => {
  test("installs an aboveEditor widget that renders live usage; shutdown clears it", async () => {
    const handlers: Record<string, Handler> = {};
    const widgetCalls: unknown[] = [];
    let renders = 0;
    let baseUrl: string | undefined;
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        limits: [
          limit({
            windowId: "5h",
            remainingFraction: 0.62,
            resetsAt: Date.now() + 90 * MIN,
          }),
        ],
      },
    ];
    const ctx = uiCtx({
      reports,
      widgetCalls,
      onFetch: (o) => {
        baseUrl = o.baseUrlResolver("anthropic");
      },
    });
    usageStatus(fakePi(handlers));
    try {
      handlers["session_start"]?.({}, ctx);
      expect(widgetCalls).toHaveLength(1);
      const [key, factory, opts] = widgetCalls[0] as [
        string,
        WidgetFactory,
        unknown,
      ];
      expect(key).toBe("usage-status");
      expect(opts).toEqual({ placement: "aboveEditor" });
      const component = factory({ requestRender: () => renders++ }, FAKE_THEME);
      expect(component.render(200)).toEqual([]); // no data fetched yet
      await flushMicrotasks();
      expect(baseUrl).toBe("https://api/anthropic");
      expect(renders).toBeGreaterThan(0);
      expect(component.render(200)).toEqual(["Claude 5h 62% (1h30m)"]);
      expect(component.render(13)).toEqual(["Claude 5h 62%"]); // drops reset to fit
      expect(component.render(5)).toEqual([]); // hides when nothing fits
    } finally {
      handlers["session_shutdown"]?.({}, ctx);
    }
    expect(widgetCalls.at(-1)).toEqual([
      "usage-status",
      undefined,
      { placement: "aboveEditor" },
    ]);
  });
});

describe("usageStatus headless", () => {
  test("headless mode (no UI) neither installs a widget nor fetches", async () => {
    const handlers: Record<string, Handler> = {};
    const widgetCalls: unknown[] = [];
    let fetched = false;
    const ctx = uiCtx({
      reports: [],
      widgetCalls,
      hasUI: false,
      onFetch: () => {
        fetched = true;
      },
    });
    usageStatus(fakePi(handlers));
    handlers["session_start"]?.({}, ctx);
    await flushMicrotasks();
    expect(fetched).toBe(false);
    expect(widgetCalls).toHaveLength(0);
  });
});

describe("usageStatus refresh", () => {
  test("fires the interval tick to re-render and reinstalls on session_switch", async () => {
    jest.useFakeTimers();
    const handlers: Record<string, Handler> = {};
    const widgetCalls: unknown[] = [];
    let renders = 0;
    let fetches = 0;
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        limits: [limit({ windowId: "5h", remainingFraction: 0.5 })],
      },
    ];
    const ctx = uiCtx({
      reports,
      widgetCalls,
      onFetch: () => {
        fetches++;
      },
    });
    try {
      usageStatus(fakePi(handlers));
      handlers["session_start"]?.({}, ctx);
      const factory = (widgetCalls[0] as [string, WidgetFactory, unknown])[1];
      factory({ requestRender: () => renders++ }, FAKE_THEME);
      await flushMicrotasks();
      const before = renders;
      jest.advanceTimersByTime(60_000); // interval → tick → redraw
      expect(renders).toBeGreaterThan(before);
      handlers["session_switch"]?.({}, ctx); // resets state and reinstalls
      expect(widgetCalls.length).toBeGreaterThan(1);
      expect(fetches).toBeGreaterThanOrEqual(2);
    } finally {
      handlers["session_shutdown"]?.({}, ctx);
      jest.useRealTimers();
    }
  });
});

describe("usageStatus resilience", () => {
  test("drops malformed reports and limits from the fetch payload", async () => {
    const handlers: Record<string, Handler> = {};
    const widgetCalls: unknown[] = [];
    const malformed = [
      null,
      42,
      { provider: 123, limits: [] },
      { provider: "x", limits: "nope" },
      {
        provider: "anthropic",
        limits: [
          null,
          7,
          { scope: {} },
          { amount: { remainingFraction: 0.5 }, scope: { windowId: 5 } },
          { amount: { usedFraction: "high" }, scope: {} },
          { amount: {}, scope: {}, window: { durationMs: "5h" } },
          limit({ windowId: "5h", remainingFraction: 0.4 }),
        ],
      },
    ] as unknown as UsageReportLike[];
    const ctx = uiCtx({ reports: malformed, widgetCalls });
    usageStatus(fakePi(handlers));
    try {
      handlers["session_start"]?.({}, ctx);
      const c = (widgetCalls[0] as [string, WidgetFactory, unknown])[1](
        { requestRender() {} },
        FAKE_THEME,
      );
      await flushMicrotasks();
      expect(c.render(200)).toEqual(["Claude 5h 40%"]);
    } finally {
      handlers["session_shutdown"]?.({}, ctx);
    }
  });

  test("ignores a null usage payload without throwing", async () => {
    const handlers: Record<string, Handler> = {};
    const widgetCalls: unknown[] = [];
    const ctx = uiCtx({
      reports: null as unknown as UsageReportLike[],
      widgetCalls,
    });
    usageStatus(fakePi(handlers));
    try {
      handlers["session_start"]?.({}, ctx);
      const c = (widgetCalls[0] as [string, WidgetFactory, unknown])[1](
        { requestRender() {} },
        FAKE_THEME,
      );
      await flushMicrotasks();
      expect(c.render(200)).toEqual([]);
    } finally {
      handlers["session_shutdown"]?.({}, ctx);
    }
  });
});

describe("usageStatus session switch", () => {
  test("clears stale reports and renders freshly fetched usage after a switch", async () => {
    const handlers: Record<string, Handler> = {};
    const widgetCalls: unknown[] = [];
    const reports: UsageReportLike[] = [
      {
        provider: "anthropic",
        limits: [limit({ windowId: "5h", remainingFraction: 0.8 })],
      },
    ];
    const ctx = uiCtx({ reports, widgetCalls });
    usageStatus(fakePi(handlers));
    try {
      handlers["session_start"]?.({}, ctx);
      const first = (widgetCalls[0] as [string, WidgetFactory, unknown])[1](
        { requestRender() {} },
        FAKE_THEME,
      );
      await flushMicrotasks();
      expect(first.render(200)).toEqual(["Claude 5h 80%"]);
      reports[0] = {
        provider: "openai-codex",
        limits: [limit({ windowId: "5h", remainingFraction: 0.3 })],
      };
      handlers["session_switch"]?.({}, ctx);
      expect(widgetCalls[1]).toEqual([
        "usage-status",
        undefined,
        { placement: "aboveEditor" },
      ]); // old widget torn down before reinstall
      const second = (widgetCalls[2] as [string, WidgetFactory, unknown])[1](
        { requestRender() {} },
        FAKE_THEME,
      );
      expect(second).not.toBe(first); // lifecycle reset: fresh component
      expect(second.render(200)).toEqual([]); // stale reports cleared before refetch
      await flushMicrotasks();
      expect(second.render(200)).toEqual(["Codex 5h 30%"]);
    } finally {
      handlers["session_shutdown"]?.({}, ctx);
    }
  });
});

describe("usageStatus stale fetch", () => {
  test("a fetch in flight during a switch cannot overwrite the new session", async () => {
    const handlers: Record<string, Handler> = {};
    const widgetCalls: unknown[] = [];
    let resolveFirst: (() => void) | undefined;
    const first: UsageReportLike[] = [
      {
        provider: "anthropic",
        limits: [limit({ windowId: "5h", remainingFraction: 0.9 })],
      },
    ];
    const second: UsageReportLike[] = [
      {
        provider: "openai-codex",
        limits: [limit({ windowId: "5h", remainingFraction: 0.2 })],
      },
    ];
    let call = 0;
    const ctx = {
      hasUI: true,
      ui: { setWidget: (...args: unknown[]) => widgetCalls.push(args) },
      modelRegistry: {
        getProviderBaseUrl: () => undefined,
        authStorage: {
          fetchUsageReports: () => {
            call += 1;
            return call === 1
              ? new Promise<UsageReportLike[]>((res) => {
                  resolveFirst = () => res(first);
                })
              : Promise.resolve(second);
          },
        },
      },
    } as unknown as ExtensionContext;
    usageStatus(fakePi(handlers));
    try {
      handlers["session_start"]?.({}, ctx); // fetch #1 starts, stays pending
      handlers["session_switch"]?.({}, ctx); // teardown + fetch #2
      const comp = (widgetCalls.at(-1) as [string, WidgetFactory, unknown])[1](
        { requestRender() {} },
        FAKE_THEME,
      );
      await flushMicrotasks();
      expect(comp.render(200)).toEqual(["Codex 5h 20%"]);
      resolveFirst?.(); // stale fetch #1 resolves late
      await flushMicrotasks();
      expect(comp.render(200)).toEqual(["Codex 5h 20%"]); // not clobbered
    } finally {
      handlers["session_shutdown"]?.({}, ctx);
    }
  });
});
