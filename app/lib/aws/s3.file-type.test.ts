// Feature: cloud-bill-analyst-web, Property 24: Report file-type indicator

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { reportFileType } from "./s3";

/**
 * Property 24 (Req 11.6): `reportFileType` classifies a report `key` by its
 * extension so the download card can show a file-type indicator:
 *   - keys ending in `.pdf`  (any case) -> "pdf"
 *   - keys ending in `.xlsx` (any case) -> "xlsx"
 *   - everything else                   -> null
 */

/** Case-insensitive re-spelling of an extension, e.g. ".pdf" -> ".PdF". */
function anyCaseArb(ext: string) {
  return fc
    .array(fc.boolean(), { minLength: ext.length, maxLength: ext.length })
    .map((flags) =>
      ext
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join(""),
    );
}

/** Arbitrary path prefix + filename stem preceding the target extension. */
const stem = fc.string({ maxLength: 60 });

describe("reportFileType (Property 24)", () => {
  it("classifies any key ending in .pdf (any case) as \"pdf\"", () => {
    fc.assert(
      fc.property(stem, anyCaseArb(".pdf"), (prefix, ext) => {
        const key = `${prefix}${ext}`;
        expect(reportFileType(key)).toBe("pdf");
      }),
    );
  });

  it("classifies any key ending in .xlsx (any case) as \"xlsx\"", () => {
    fc.assert(
      fc.property(stem, anyCaseArb(".xlsx"), (prefix, ext) => {
        const key = `${prefix}${ext}`;
        expect(reportFileType(key)).toBe("xlsx");
      }),
    );
  });

  it("returns null for any key ending in neither .pdf nor .xlsx", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (key) => {
        const lower = key.toLowerCase();
        // Guard: exclude the two recognized extensions so this is the null class.
        fc.pre(!lower.endsWith(".pdf") && !lower.endsWith(".xlsx"));
        expect(reportFileType(key)).toBeNull();
      }),
    );
  });
});
