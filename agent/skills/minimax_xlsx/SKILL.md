# Skill: minimax-xlsx

Builds a formatted `.xlsx` AWS cost report in-container (no network).

- Engine: openpyxl (+ pandas/lxml available in the image).
- Invocation: `python skills/minimax_xlsx/build_xlsx.py --spec <spec.json>`
  - Writes `spec.output_path`, prints the absolute path to stdout (exit 0).
- Charts: any PNG paths in `spec.charts` are embedded on a "Charts" sheet.

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

Note: this is a functional in-container equivalent of the "minimax-xlsx" skill,
using the plan's specified toolchain and file-build contract.
