# Skill: minimax-pdf

Builds a `.pdf` AWS cost report in-container (no network).

- Engine: reportlab (+ pypdf available for merge/append; LibreOffice and
  Node/Playwright/Chromium are bundled in the image for richer HTML-based
  rendering if a future variant needs it).
- Fonts: bundled DejaVuSans (registered when present) for currency/glyph
  coverage; falls back to Helvetica.
- Invocation: `python skills/minimax_pdf/build_pdf.py --spec <spec.json>`
  - Writes `spec.output_path`, prints the absolute path to stdout (exit 0).
- Charts: any PNG paths in `spec.charts` are embedded, scaled to page width.

Spec JSON: identical schema to the minimax-xlsx skill (see its SKILL.md).

Note: this is a functional in-container equivalent of the "minimax-pdf" skill,
using the plan's specified toolchain and file-build contract.
