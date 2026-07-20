# Skill: minimax-xlsx

Builds a high-end `.xlsx` AWS cost report in-container (no network).

Workbook:
- **Overview** - title, a 4-up KPI card band, a derived **Key insights** panel and
  two NATIVE (editable) Excel charts: a doughnut of cost composition and a bar of
  cost by service, both driven by the Details table. Gridlines hidden.
- **Details** - the line-item table with a computed *Share* column, in-cell data
  bars on the USD column, a frozen header and an auto-filter.

Every figure and insight is derived from the spec rows - nothing is invented.

- Engine: openpyxl (native charts + conditional-format data bars).
- Palette / formatting / insight computation: shared `skills/report_common.py`.
- Invocation: `python skills/minimax_xlsx/build_xlsx.py --spec <spec.json>`
  - Writes `spec.output_path`, prints the absolute path to stdout (exit 0).
- Charts: native Excel charts are generated from the data; PNG paths in
  `spec.charts` are not required (the PDF skill embeds those).

Spec JSON (output_path + rows required):
```json
{
  "title": "AWS Cost Report",
  "subtitle": "prod-account - June 2026",
  "period": {"start": "2026-06-01", "end": "2026-07-01"},
  "currency": {"display": "IDR", "usd_rate": 17958.44, "as_of": "..."},
  "rows": [{"service": "Amazon EC2", "usd": 800.0, "display": 14366752.0}],
  "total": {"usd": 1234.56, "display": 22170000.0},
  "charts": ["/tmp/cba-artifacts/.../chart-abc.png"],
  "notes": ["Figures from AWS Cost Explorer (UnblendedCost)."],
  "output_path": "/tmp/cba-artifacts/.../report.xlsx"
}
```

Note: functional in-container equivalent of the "minimax-xlsx" skill, using the
plan's specified toolchain and file-build contract.
