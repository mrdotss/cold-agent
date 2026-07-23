"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { ChartSpec } from "@/lib/aws/sse";

/**
 * Inline, client-rendered chart for a single `ChartSpec` (Req 4.1–4.10, 13.3).
 *
 * Presentational and pure with respect to data: it renders the structured
 * `spec` the browser already received on a narrowed `chart` SSE event — no
 * image, no S3 object, no presigned URL (Req 4.2). It imports NO server-only /
 * `@aws-sdk` module (Req 13.3); the only external type it touches is the
 * client-safe `ChartSpec` from the pure `lib/aws/sse` module.
 *
 * Theming follows the "Sera" preset: a violet data series (`var(--primary)`),
 * a serif caption (the `Card` title renders in `--font-heading` / Noto Serif),
 * sharp zero-radius corners (bars/cards inherit `--radius: 0`), and solid
 * fills — no gradients (Req 4.6). It renders responsively to its container via
 * `ChartContainer` → Recharts `ResponsiveContainer` and exposes interactive
 * tooltips (Req 4.7).
 */

/** A single chart datum: a label paired with its numeric value. */
export interface ChartRow {
  name: string;
  value: number;
}

/**
 * Pair each `labels[i]` with `values[i]` into a `{ name, value }` row for every
 * index of the `labels` array (Req 4.4).
 *
 * Pure and total: it walks the `labels` array (the authoritative index space)
 * so a well-formed spec — where `labels.length === values.length`, as
 * guaranteed by `toKnownEvent` — yields exactly one row per label. It never
 * throws; a missing `values[i]` coerces to `NaN` rather than crashing.
 */
export function toChartRows(spec: ChartSpec): ChartRow[] {
  return spec.labels.map((name, index) => ({
    name,
    value: typeof spec.values[index] === "number" ? spec.values[index] : Number.NaN,
  }));
}

/** The single data-series key used by the bar/line charts. */
const SERIES_KEY = "value";

/**
 * A violet series derived from the preset accent (`--primary`), stepping down
 * in opacity for multi-slice (pie/donut) charts so each slice stays within the
 * violet family (Req 4.6) instead of pulling in unrelated hues. Solid fills,
 * no gradients.
 */
const VIOLET_SERIES: readonly string[] = [
  "var(--primary)",
  "color-mix(in oklch, var(--primary) 84%, var(--card))",
  "color-mix(in oklch, var(--primary) 68%, var(--card))",
  "color-mix(in oklch, var(--primary) 52%, var(--card))",
  "color-mix(in oklch, var(--primary) 38%, var(--card))",
  "color-mix(in oklch, var(--primary) 26%, var(--card))",
];

/** The violet fill for the i-th slice, cycling through the derived series. */
function sliceColor(index: number): string {
  return VIOLET_SERIES[index % VIOLET_SERIES.length];
}

/**
 * Build an `Intl.NumberFormat` for the spec `currency` (Req 4.5). Falls back to
 * a plain number format if the currency code is not a valid ISO 4217 value, so
 * a malformed `currency` never throws during render.
 */
function makeCurrencyFormatter(
  currency: string,
  options?: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      ...options,
    });
  } catch {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
      ...options,
    });
  }
}

export interface ChartInlineProps {
  spec: ChartSpec;
  className?: string;
}

/**
 * Render one `ChartSpec` as a themed, interactive, responsive chart inside a
 * framed card captioned with the spec `title`.
 */
export function ChartInline({ spec, className }: ChartInlineProps) {
  const rows = React.useMemo(() => toChartRows(spec), [spec]);

  // Full-precision currency for tooltip values (Req 4.5).
  const valueFormatter = React.useMemo(
    () => makeCurrencyFormatter(spec.currency, { maximumFractionDigits: 2 }),
    [spec.currency],
  );
  // Compact currency for numeric axis ticks so long axes stay legible (Req 4.5).
  const axisFormatter = React.useMemo(
    () =>
      makeCurrencyFormatter(spec.currency, {
        notation: "compact",
        maximumFractionDigits: 1,
      }),
    [spec.currency],
  );

  const formatValue = React.useCallback(
    (value: unknown) =>
      valueFormatter.format(typeof value === "number" ? value : Number(value)),
    [valueFormatter],
  );
  const formatAxis = React.useCallback(
    (value: unknown) =>
      axisFormatter.format(typeof value === "number" ? value : Number(value)),
    [axisFormatter],
  );

  const chartConfig = React.useMemo<ChartConfig>(() => {
    if (spec.chart_type === "pie") {
      // One config entry per slice, keyed by label, so the tooltip/legend can
      // resolve each slice's name and violet color.
      const config: ChartConfig = {};
      spec.labels.forEach((label, index) => {
        config[label] = { label, color: sliceColor(index) };
      });
      return config;
    }
    // Single violet series for bar/hbar/line.
    return {
      [SERIES_KEY]: { label: spec.title, color: "var(--primary)" },
    } satisfies ChartConfig;
  }, [spec.chart_type, spec.labels, spec.title]);

  const isEmpty = spec.labels.length === 0;

  return (
    <Card
      size="sm"
      className={className}
      data-slot="chart-inline"
      data-chart-type={spec.chart_type}
    >
      <CardHeader>
        {/* Serif caption (Noto Serif via `--font-heading`) — Req 4.2, 4.6. */}
        <CardTitle>{spec.title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          // Empty-state placeholder inside the framed card — no chart, no throw
          // (Req 4.8).
          <div
            role="status"
            data-slot="chart-empty"
            className="flex min-h-40 items-center justify-center border border-dashed border-border text-sm text-muted-foreground"
          >
            No data to chart
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="w-full">
            {renderChart(spec, rows, {
              chartConfig,
              formatValue,
              formatAxis,
            })}
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

interface RenderContext {
  chartConfig: ChartConfig;
  formatValue: (value: unknown) => string;
  formatAxis: (value: unknown) => string;
}

/**
 * Pick and render the Recharts chart for the spec's `chart_type` (Req 4.3):
 *  - `bar`  → vertical bar chart
 *  - `hbar` → horizontal bar chart (`layout="vertical"`)
 *  - `line` → line chart
 *  - `pie`  → donut chart (`Pie` with `innerRadius`)
 *
 * Returns a single Recharts element so it can be the sole child of
 * `ChartContainer` → `ResponsiveContainer`.
 */
function renderChart(
  spec: ChartSpec,
  rows: ChartRow[],
  ctx: RenderContext,
): React.ReactElement {
  const { formatValue, formatAxis } = ctx;

  const tooltip = (
    <ChartTooltip
      cursor={false}
      content={
        <ChartTooltipContent
          formatter={(value) => (
            <span className="font-mono font-medium text-foreground tabular-nums">
              {formatValue(value)}
            </span>
          )}
        />
      }
    />
  );

  switch (spec.chart_type) {
    case "hbar":
      return (
        <BarChart accessibilityLayer data={rows} layout="vertical">
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickFormatter={formatAxis} tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            width={110}
          />
          {tooltip}
          {/* radius 0 → sharp corners (Req 4.6); solid violet fill, no gradient. */}
          <Bar dataKey={SERIES_KEY} fill="var(--primary)" radius={0} />
        </BarChart>
      );

    case "line":
      return (
        <LineChart accessibilityLayer data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickFormatter={formatAxis} tickLine={false} axisLine={false} />
          {tooltip}
          <Line
            dataKey={SERIES_KEY}
            type="monotone"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      );

    case "pie":
      return (
        <PieChart accessibilityLayer>
          <ChartTooltip
            content={
              <ChartTooltipContent
                nameKey="name"
                hideLabel
                formatter={(value, name) => (
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="text-muted-foreground">{String(name)}</span>
                    <span className="font-mono font-medium text-foreground tabular-nums">
                      {formatValue(value)}
                    </span>
                  </span>
                )}
              />
            }
          />
          {/* innerRadius → donut (Req 4.3); violet slices, no gradient. */}
          <Pie data={rows} dataKey={SERIES_KEY} nameKey="name" innerRadius={56} strokeWidth={1}>
            {rows.map((row, index) => (
              <Cell key={row.name} fill={sliceColor(index)} />
            ))}
          </Pie>
        </PieChart>
      );

    case "bar":
    default:
      return (
        <BarChart accessibilityLayer data={rows}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickFormatter={formatAxis} tickLine={false} axisLine={false} />
          {tooltip}
          {/* radius 0 → sharp corners (Req 4.6); solid violet fill, no gradient. */}
          <Bar dataKey={SERIES_KEY} fill="var(--primary)" radius={0} />
        </BarChart>
      );
  }
}
