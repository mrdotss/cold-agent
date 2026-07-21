"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Download04Icon,
  File01Icon,
  FileSpreadsheetIcon,
  Pdf01Icon,
} from "@hugeicons/core-free-icons";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ResolvedReport } from "@/hooks/useAgentStream";

/**
 * Report download card (Req 11.5, 11.6).
 *
 * Presentational and pure: it renders FROM a `ResolvedReport` — the hook mints
 * the presigned URL server-side (via `GET /api/report-url`) and attaches `url`
 * (and `fileType`) to the marker once it resolves. This component owns no fetch
 * and imports no `server-only` module.
 *
 *  - Req 11.5: WHILE the presigned URL is not yet available, render NOTHING.
 *    We return `null` unless a non-empty `url` is present — never on the
 *    `report_file` marker/key alone.
 *  - Req 11.6: WHEN the URL is available, render a download card carrying a
 *    file-type indicator (icon + label) reflecting PDF vs XLSX, the filename,
 *    and a keyboard-reachable Download control (an `<a download>` styled as a
 *    Violet button).
 *
 * The file-type indicator prefers the `fileType` attached by the hook, falling
 * back to the report key's extension so the card still labels itself correctly
 * if the field is absent (the server-only `reportFileType` is deliberately NOT
 * imported here — that would drag `s3.ts` into the client bundle).
 */

type ReportFileType = "pdf" | "xlsx";

export interface ReportCardProps {
  /** The report S3 key (used for the filename + as a file-type fallback). */
  reportKey: string;
  /**
   * The resolved presigned download URL. The card renders only once this is a
   * non-empty string (Req 11.5).
   */
  url?: string;
  /** File type resolved by the presign; falls back to the key's extension. */
  fileType?: string;
  className?: string;
}

/** Derive the file type from an explicit value, falling back to the key's extension. */
function resolveFileType(fileType: string | undefined, key: string): ReportFileType | null {
  if (fileType === "pdf" || fileType === "xlsx") {
    return fileType;
  }
  const lower = key.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".xlsx")) return "xlsx";
  return null;
}

/** The last non-empty path segment of the key, decoded when possible. */
function filenameFromKey(key: string): string {
  const segments = key.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1) ?? key;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const FILE_TYPE_META: Record<
  ReportFileType,
  { icon: typeof Pdf01Icon; label: string }
> = {
  pdf: { icon: Pdf01Icon, label: "PDF" },
  xlsx: { icon: FileSpreadsheetIcon, label: "XLSX" },
};

/** Build a `report-card` for a resolved report marker. Convenience over `ReportCard`. */
export function ReportCardFor({
  report,
  className,
}: {
  report: ResolvedReport;
  className?: string;
}) {
  return (
    <ReportCard
      reportKey={report.key}
      url={report.url}
      fileType={report.fileType}
      className={className}
    />
  );
}

export function ReportCard({ reportKey, url, fileType, className }: ReportCardProps) {
  // Req 11.5: never render on the marker/key alone — only once the presigned
  // URL has resolved to a non-empty string.
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }

  const resolvedType = resolveFileType(fileType, reportKey);
  const meta = resolvedType ? FILE_TYPE_META[resolvedType] : null;
  const typeLabel = meta?.label ?? "File";
  const icon = meta?.icon ?? File01Icon;
  const filename = filenameFromKey(reportKey);

  return (
    <figure
      className={cn(
        "flex items-center gap-3 border border-border bg-card/40 px-3 py-2.5",
        className,
      )}
    >
      {/* File-type indicator: HugeIcon line glyph + tracked label (Req 11.6). */}
      <span
        className="flex size-9 shrink-0 items-center justify-center border border-border text-primary"
        aria-hidden
      >
        <HugeiconsIcon icon={icon} className="size-5" strokeWidth={1.5} />
      </span>

      <figcaption className="flex min-w-0 flex-1 flex-col">
        <span
          className="truncate text-sm font-medium text-foreground"
          title={filename}
        >
          {filename}
        </span>
        <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          {typeLabel}
        </span>
      </figcaption>

      {/* Download control: an anchor styled as the Violet action button. It is
          keyboard-reachable (a native focusable link) with the preset's focus
          ring, and `download` prompts a save rather than in-tab navigation. */}
      <a
        href={url}
        download={filename}
        className={cn(buttonVariants({ variant: "default", size: "sm" }), "shrink-0")}
        aria-label={`Download ${filename} (${typeLabel})`}
      >
        <HugeiconsIcon
          icon={Download04Icon}
          data-icon="inline-start"
          aria-hidden
        />
        Download
      </a>
    </figure>
  );
}
