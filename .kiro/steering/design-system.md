# Design system & agentic-chat UX

Target: a **premium, editorial** product — not a generic AI-chat template. Aim for
"expensive, considered" (Linear/Vercel-tier polish in an editorial voice).

## Skills to apply
When building UI, apply these workspace skills (activate them):
`shadcn` (component generation/registry), `minimalist-ui` (editorial minimalism),
`high-end-visual-design` (spacing, hierarchy, motion, anti-slop), and
`design-taste-frontend` (avoid templated looks).
**On any conflict, the preset tokens below win** (e.g. the preset uses sharp
corners + serif display — do NOT override with rounded squircles or Grotesk).

## Design DNA — the preset (already chosen)
Initialize with: `pnpm dlx shadcn@latest init --preset b5AMdfnOzw --template next`
(Base UI variant). The preset is the **"Sera"** system:
- **Type:** headings **Noto Serif** (editorial serif), body **Lora**. Uppercase,
  tracked serif section labels (e.g. `CONTRIBUTION HISTORY`).
- **Color:** base **Zinc** neutrals, accent **Violet**; light surface with an
  optional dark menu. Support light + dark.
- **Radius: None** — sharp, crisp corners. Do not round cards into pills.
- **Icons: HugeIcons** — light line icons only (never heavy/filled default sets).
- **Surfaces:** flat cards with hairline borders, generous whitespace, refined
  *diffused* shadows only. **No gradients, no heavy drop shadows.**

## Chat anatomy (the core experience)
Build from the shadcn Base UI registry (`Message`, `Message Scroller`, etc.).
Map each piece to the references in `references/`:

1. **Agent intro / empty state** (ref-1, ref-5): agent name "Cloud Bill Analyst"
   + a small model badge + a short capability list (Analyze spend · Detect
   anomalies · Export PDF/Excel) + connected-account chip.
2. **Message list** (ref-3, ref-8): user turns as subtle right-aligned zinc
   bubbles; assistant as plain left-aligned prose with inline `code` chips and
   **markdown tables** (the agent replies with cost tables). Use `Message
   Scroller` for anchored auto-scroll that follows streaming without jumping.
3. **Live activity timeline** — the signature "agentic" element (ref-2, ref-4).
   Render the `tool` SSE events as a compact, collapsible step list attached to
   the in-progress assistant turn:
   - each step = HugeIcon + the event's **`status`** (a friendly, *variative*
     phrase, e.g. "Querying AWS Cost Explorer…") + a small **`label`** badge
     ("Cost Explorer" / "Chart" / "Report");
   - spinner while a step is open (`start` seen, no `end`); check-mark on `end`
     (match by `id`);
   - on `done`, **collapse** into a one-line summary ("Analyzed spend · converted
     currency · rendered chart · saved report") that can be re-expanded.
   Optionally present it "Thought for Xs / Chain of Thought"-style (ref-2/4).
4. **Message actions** (ref-6): copy · regenerate · thumbs up/down under each
   assistant turn.
5. **Report download card**: on a `report_file` event, presign server-side, then
   render a card with a file-type icon (PDF/XLSX), filename, size and Download.
   **Render the card only once the presigned URL is ready** (not on the marker).
6. **Cost-anomaly flags**: when the agent flags unusual spend (spike / new service
   / large MoM delta), surface it as an inline callout (amber/rose accent) in chat
   and as a badge on the dashboard.
7. **Suggestions / quick actions**: recommendation-style prompt chips that feel
   AI-generated and **vary their wording** per render (e.g. "Scan this month's
   spend", "Where did costs spike?", "Export June as PDF", "Break down by
   service"). Present them as suggestions, not fixed buttons.
8. **Human-in-the-loop confirm** (ref-7): an approve/reject inline prompt for
   sensitive confirmations (e.g. first scan of a newly connected account, or a
   costly export). Keep the pattern; use sparingly in MVP.
9. **Composer**: text input with a `+`/attach affordance and a circular send
   button. When no AWS account is connected, the composer is **disabled** with a
   "Connect an account to start" hint.

## States
- **Chat disabled** until ≥1 account connected → show a connect-account CTA card.
- Streaming, empty-thread, and error states (drive errors from the `error` event).
- Account switcher + thread list (sidebar) for multiple accounts / conversations.

## Motion & quality bar
Apply `high-end-visual-design` **principles** within the preset's language:
heavy section whitespace, clear type hierarchy, custom cubic-bezier transitions,
gentle enter/scroll reveals, tactile button feedback — but keep **sharp corners,
serif display, flat surfaces, no gradients**. Respect `prefers-reduced-motion`.
Stream status via an `aria-live="polite"` region; full keyboard support.
