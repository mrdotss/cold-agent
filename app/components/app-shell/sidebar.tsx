"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  CloudIcon,
  DashboardSquare01Icon,
  Logout01Icon,
  Menu01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";

import { AccountSwitcher } from "@/components/accounts/account-switcher";
import { ConversationList } from "@/components/app-shell/conversation-list";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { ConversationListItem } from "@/hooks/useConversations";
import { setActiveAccount } from "@/lib/actions/accounts";
import { logout } from "@/lib/actions/login";
import type { ConnectedAccountView } from "@/lib/db/views";
import { cn } from "@/lib/utils";

/**
 * Guarded app shell (task 17.2; Req 2.4, 2.5, 5.4, 8.9).
 *
 * A persistent editorial sidebar plus the page content area. The server layout
 * that renders this component performs the auth guard and loads the browser-safe
 * data (accounts, active-account id, and the user's own conversations); this client
 * component owns the interactivity: switching the active account, starting a new
 * chat, sign-out, and the responsive mobile drawer.
 *
 * Only browser-safe views ever reach here — {@link ConnectedAccountView} and
 * {@link ConversationListItem} both exclude account secrets and the runtime
 * session id.
 */
export interface AppShellProps {
  /** The signed-in user's email, for the sidebar footer identity line. */
  userEmail: string | null;
  /** The user's connected accounts (browser-safe views; may be empty). */
  accounts: ConnectedAccountView[];
  /** The active-account id, or `null` when none is selected. */
  activeId: string | null;
  /**
   * The authenticated user's own conversations, most-recently-updated first, to
   * seed the sidebar list without an initial fetch flash (Req 8.9). These are
   * browser-safe items (no `sessionId`); the client {@link ConversationList}
   * takes over interactivity + optimistic updates from here.
   */
  initialConversations: ConversationListItem[];
  children: React.ReactNode;
}

export function AppShell({
  userEmail,
  accounts,
  activeId,
  initialConversations,
  children,
}: AppShellProps) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  // Close the mobile drawer on route change so a navigation never leaves it
  // open. Uses the "adjust state during render" pattern (comparing the current
  // pathname to the last one we synced) rather than an effect + setState.
  const pathname = usePathname();
  const [lastPathname, setLastPathname] = React.useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setMobileOpen(false);
  }

  // Escape closes the mobile drawer for keyboard users.
  React.useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <div className="flex h-svh flex-col overflow-hidden md:flex-row">
      {/* Persistent sidebar (md and up). Full viewport height with its own
          internal scroll so the page body never scrolls it out of view. */}
      <aside className="hidden w-72 shrink-0 overflow-hidden border-r border-border bg-card md:flex md:flex-col md:h-svh">
        <SidebarBody
          userEmail={userEmail}
          accounts={accounts}
          activeId={activeId}
          initialConversations={initialConversations}
        />
      </aside>

      {/* Mobile top bar + drawer (below md). */}
      <header className="flex items-center gap-3 border-b border-border bg-card px-4 py-3 md:hidden">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          aria-controls="app-mobile-nav"
          onClick={() => setMobileOpen(true)}
        >
          <HugeiconsIcon icon={Menu01Icon} />
        </Button>
        <Link
          href="/dashboard"
          className="font-heading text-sm font-semibold tracking-[0.2em] uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cloud Bill Analyst
        </Link>
      </header>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          {/* Scrim */}
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-foreground/40 transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
            onClick={() => setMobileOpen(false)}
          />
          <aside
            id="app-mobile-nav"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-card shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
          >
            <div className="flex items-center justify-end px-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close navigation"
                onClick={() => setMobileOpen(false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} />
              </Button>
            </div>
            <SidebarBody
              userEmail={userEmail}
              accounts={accounts}
              activeId={activeId}
              initialConversations={initialConversations}
            />
          </aside>
        </div>
      ) : null}

      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}

/** Primary navigation destinations (Req: Dashboard, Accounts links). */
const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: DashboardSquare01Icon },
  { href: "/accounts", label: "Accounts", icon: CloudIcon },
] as const;

/**
 * The shared sidebar content, rendered inside both the persistent desktop
 * sidebar and the mobile drawer. Contains the brand, primary nav, the active
 * account switcher (or a connect-account affordance when there are none —
 * Req 5.4), the interactive {@link ConversationList} (optimistic create +
 * editable AI titles — Req 1, Req 11), and the sign-out control (Req 2.5).
 *
 * The conversation list is a self-contained client component; this body wires
 * its navigation (client-side `router.push` to `/chat/<conversationId>` with NO
 * full reload — Req 1.4) and surfaces its errors into the existing `notice`.
 */
function SidebarBody({
  userEmail,
  accounts,
  activeId,
  initialConversations,
}: Omit<AppShellProps, "children">) {
  const router = useRouter();
  const pathname = usePathname();

  const [switching, setSwitching] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const hasAccounts = accounts.length > 0;
  // The account a new chat will be pinned to: the active one, else the first.
  const newChatAccountId = activeId ?? accounts[0]?.id ?? null;

  // The currently open conversation id, parsed from a `/chat/<id>` pathname, so
  // the list can render its active-row left border. `undefined` off the chat
  // routes.
  const activeConversationId = React.useMemo(() => {
    const match = /^\/chat\/([^/]+)/.exec(pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  }, [pathname]);

  const handleSelectAccount = React.useCallback(
    (accountId: string) => {
      setSwitching(true);
      setNotice(null);
      void (async () => {
        const result = await setActiveAccount(accountId);
        if (!result.ok) setNotice(result.message);
        setSwitching(false);
        router.refresh();
      })();
    },
    [router],
  );

  // On a successful optimistic create, navigate to the new conversation WITHOUT
  // a full reload (Req 1.4). The list already updated optimistically via the
  // hook, so a `router.push` is enough — no `router.refresh()`.
  const handleConversationCreated = React.useCallback(
    (conversationId: string) => {
      router.push(`/chat/${conversationId}`);
    },
    [router],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4">
      <Link
        href="/dashboard"
        className="hidden px-2 pt-2 font-heading text-sm font-semibold tracking-[0.2em] uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:block"
      >
        Cloud Bill Analyst
      </Link>

      {/* Primary navigation */}
      <nav aria-label="Primary" className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 border-l-2 px-3 py-2 text-sm transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                active
                  ? "border-primary bg-muted font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <HugeiconsIcon icon={item.icon} className="size-4 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <Separator />

      {/* Active account (Req 5.4, 5.5) */}
      <section className="flex flex-col gap-2">
        <span className="px-1 text-[0.65rem] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
          Active account
        </span>
        {hasAccounts ? (
          <AccountSwitcher
            accounts={accounts}
            activeId={activeId}
            onSelect={handleSelectAccount}
            disabled={switching}
            className="w-full [&_[data-slot=select-trigger]]:w-auto [&_[data-slot=select-trigger]]:min-w-0 [&_[data-slot=select-trigger]]:flex-1"
          />
        ) : (
          <Link
            href="/accounts"
            className="flex items-center gap-3 border border-dashed border-border px-3 py-3 text-sm text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <HugeiconsIcon icon={PlusSignIcon} className="size-4 shrink-0" />
            Connect an account
          </Link>
        )}
      </section>

      {/* Conversations (Req 1, 8.9, 10, 11) — the interactive client list owns
          the optimistic "New" control, inline rename, and pending-title
          firing; this body wires navigation + error surfacing. */}
      <ConversationList
        accountCount={accounts.length}
        newChatAccountId={newChatAccountId}
        activeConversationId={activeConversationId}
        initialConversations={initialConversations}
        onCreated={handleConversationCreated}
        onError={setNotice}
      />

      {notice ? (
        <p className="px-1 text-xs text-destructive" role="status">
          {notice}
        </p>
      ) : null}

      <Separator />

      {/* Identity + theme + sign out (Req 2.5, 20.2, 20.3) */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          {userEmail ? (
            <p
              className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground"
              title={userEmail}
            >
              {userEmail}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <ThemeToggle />
        </div>
        <form action={logout}>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="w-full justify-start"
          >
            <HugeiconsIcon icon={Logout01Icon} data-icon="inline-start" />
            Sign out
          </Button>
        </form>
      </div>
    </div>
  );
}
