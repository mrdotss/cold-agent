# Product — Cloud Bill Analyst (Web)

> Steering for the **Next.js web app** in `app/`. The Python AgentCore runtime in
> `agent/` is already built and deployed; this app is its conversational front end.

## What it is
A web app where a user signs in, connects their AWS account **read-only**, and
**chats** with the Cloud Bill Analyst agent to understand their spend and export
polished **PDF / Excel** reports. The chat is *agentic*: it streams the answer and
shows a live timeline of what the agent is doing (querying Cost Explorer,
converting currency, rendering a chart, saving a report).

## Who it's for
AWS account owners / FinOps-minded developers who want conversational cost
analysis and shareable reports without building dashboards.

## MVP scope
- **Auth** — email/password (Auth.js).
- **Connect AWS account (wizard)** — a secure, read-only cross-account role +
  `external_id`. **No AWS keys are ever collected or stored.**
- **Agentic chat** — scan billing, ask free-form questions, watch a **live
  activity timeline**, read streamed answers. Chat is **disabled until ≥1 AWS
  account is connected**.
- **Reports** — ask the agent to export **PDF/XLSX**; show a **download card**
  once the presigned URL is ready.
- **Cost-anomaly flags** — surface unusual spend (spikes / new services / large
  MoM deltas) inline in chat and on the dashboard.
- **Multiple connected accounts** (account switcher) and **multiple chat
  threads** (saved history).

## Iteration 2 — persistence, titles & inline charts (current pass)
- **Persisted chat history** — conversations and their messages are saved to
  **DynamoDB** (NoSQL) and reload across sessions/devices. (Auth + connected
  accounts stay in Postgres.)
- **Inline charts in chat** — when the agent renders a chart it now streams a
  `chart` event; the chat shows the chart **as an inline image**, not just text.
- **Conversation titles** — a new conversation is titled by **AI** (a short
  summary of the first user prompt, kept brief) and is **user-editable** (rename)
  from the sidebar; a user-set title is never overwritten by the AI.
- **Snappy conversation list** — creating a conversation updates the sidebar
  **without a page reload** (optimistic insert + revalidate; the "New" control
  returns to idle immediately, never stuck spinning).

## Future (explicitly out of MVP)
Scheduled monthly report email · budget-threshold alerts · multi-account rollup
dashboard · shared/org workspaces.

## Non-negotiables
- The agent is **only** ever invoked from the server (it needs AWS creds).
- `role_arn` / `external_id` are **secrets**: resolved server-side per connected
  account, **never** sent to or held by the browser.
- Read-only to customer accounts (Cost Explorer reads only). The app never gets
  write access to a customer's AWS account.
