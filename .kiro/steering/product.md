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

## Future (explicitly out of MVP)
Scheduled monthly report email · budget-threshold alerts · multi-account rollup
dashboard · shared/org workspaces.

## Non-negotiables
- The agent is **only** ever invoked from the server (it needs AWS creds).
- `role_arn` / `external_id` are **secrets**: resolved server-side per connected
  account, **never** sent to or held by the browser.
- Read-only to customer accounts (Cost Explorer reads only). The app never gets
  write access to a customer's AWS account.
