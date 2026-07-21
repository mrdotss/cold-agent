import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AnalyticsUpIcon,
  Alert02Icon,
  FileExportIcon,
} from "@hugeicons/core-free-icons";

/**
 * Shared editorial layout for the public auth group (`/login`, `/register`).
 *
 * A flat two-column composition in the Sera language: a left brand panel (shown
 * from `lg` up) with the product name, a short editorial line, and the core
 * capability list; the right column hosts the auth form. Sharp corners, hairline
 * borders, generous whitespace, no gradients or heavy shadows.
 */
export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const capabilities = [
    { icon: AnalyticsUpIcon, label: "Analyze spend" },
    { icon: Alert02Icon, label: "Detect anomalies" },
    { icon: FileExportIcon, label: "Export PDF / Excel" },
  ] as const;

  return (
    <main className="grid min-h-svh grid-cols-1 lg:grid-cols-2">
      <aside className="hidden flex-col justify-between border-r border-border bg-card p-12 lg:flex">
        <Link
          href="/"
          className="font-heading text-sm font-semibold tracking-[0.2em] uppercase"
        >
          Cloud Bill Analyst
        </Link>

        <div className="flex max-w-md flex-col gap-6">
          <p className="text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            FinOps, conversational
          </p>
          <h1 className="font-heading text-3xl leading-tight font-semibold">
            Understand your AWS spend by asking for it.
          </h1>
          <p className="leading-relaxed text-muted-foreground">
            Connect an account read-only, then chat with an agent that queries
            Cost Explorer, flags anomalies, and exports polished reports.
          </p>
          <ul className="flex flex-col gap-3 pt-2">
            {capabilities.map(({ icon, label }) => (
              <li key={label} className="flex items-center gap-3 text-sm">
                <HugeiconsIcon icon={icon} className="size-4 text-primary" />
                {label}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">
          No AWS access keys are ever collected or stored.
        </p>
      </aside>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </main>
  );
}
