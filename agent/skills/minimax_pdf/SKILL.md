# Skill: minimax-pdf

Builds a high-end `.pdf` AWS cost report in-container (no network).

Design: editorial layout on white - an eyebrow/title band, a 4-up KPI card strip,
a derived **Key insights** panel, framed charts and a clean hairline breakdown
table (with a computed *Share* column), plus a page footer with page numbers.
Every figure and insight is derived from the spec rows - nothing is invented.

- Engine: reportlab.
- Fonts: bundled Plus Jakarta Sans (`skills/assets/fonts`) when present, else
  system DejaVuSans, else Helvetica (never fails on a missing font).
- Palette / formatting / insight computation: shared `skills/report_common.py`.
- Invocation: `python skills/minimax_pdf/build_pdf.py --spec <spec.json>`
  - Writes `spec.output_path`, prints the absolute path to stdout (exit 0).
- Charts: any PNG paths in `spec.charts` are embedded in framed panels, scaled
  to the page width.

Spec JSON: identical schema to the minimax-xlsx skill (see its SKILL.md).

Note: functional in-container equivalent of the "minimax-pdf" skill, using the
plan's specified toolchain and file-build contract.
