import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Integration tests for the report presign wiring (Req 11.1, 11.2, 11.4).
 *
 * Example/integration tests (NOT property tests): the S3 SDK client and the
 * `@aws-sdk/s3-request-presigner` `getSignedUrl` are mocked so no real AWS
 * call is made.
 *   - Happy path: an authorized `.pdf` key + a set bucket → `getSignedUrl`
 *     returns a URL → `{ url, fileType: "pdf", expiresIn: 300 }`, with the
 *     GetObjectCommand pointed at the right bucket+key and expiresIn in [1, 300].
 *   - Failure: a missing `CBA_REPORT_BUCKET` and a rejected presign both surface
 *     as a typed `PresignError` and never a partial URL.
 */

const { getSignedUrl, GetObjectCommand, S3Client } = vi.hoisted(() => ({
  getSignedUrl: vi.fn(),
  // Function expressions (not arrows) so they are usable with `new`.
  GetObjectCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
  S3Client: vi.fn(function () {
    return {};
  }),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client,
  GetObjectCommand,
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl,
}));

const { presignReport, PresignError } = await import("@/lib/aws/s3");

const ACTOR_ID = "user-abc-123";
const KEY = `cloud-bill-analyst/reports/${ACTOR_ID}/report.pdf`;
const BUCKET = "mr-harness";

afterEach(() => {
  vi.unstubAllEnvs();
  getSignedUrl.mockReset();
  GetObjectCommand.mockClear();
  S3Client.mockClear();
});

describe("presignReport — happy path (Req 11.1, 11.2)", () => {
  it("presigns an authorized pdf key on the bucket and returns url + fileType + expiresIn", async () => {
    vi.stubEnv("CBA_REPORT_BUCKET", BUCKET);
    vi.stubEnv("AWS_REGION", "us-east-1");

    const signedUrl =
      "https://mr-harness.s3.us-east-1.amazonaws.com/cloud-bill-analyst/reports/user-abc-123/report.pdf?X-Amz-Signature=abc";
    getSignedUrl.mockResolvedValue(signedUrl);

    const result = await presignReport(ACTOR_ID, KEY);

    expect(result).toEqual({ url: signedUrl, fileType: "pdf", expiresIn: 300 });

    // GetObjectCommand aimed at the configured bucket + exact key.
    expect(GetObjectCommand).toHaveBeenCalledTimes(1);
    const commandInput = GetObjectCommand.mock.calls[0][0] as Record<string, unknown>;
    expect(commandInput.Bucket).toBe(BUCKET);
    expect(commandInput.Key).toBe(KEY);

    // getSignedUrl used a short expiry within the allowed [1, 300]s window.
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const opts = getSignedUrl.mock.calls[0][2] as { expiresIn: number };
    expect(opts.expiresIn).toBeGreaterThanOrEqual(1);
    expect(opts.expiresIn).toBeLessThanOrEqual(300);
  });
});

describe("presignReport — failures (Req 11.4)", () => {
  it("throws PresignError and mints no URL when CBA_REPORT_BUCKET is missing", async () => {
    // No CBA_REPORT_BUCKET stubbed — the bucket lookup must fail.
    vi.stubEnv("CBA_REPORT_BUCKET", undefined);
    vi.stubEnv("AWS_REGION", "us-east-1");

    await expect(presignReport(ACTOR_ID, KEY)).rejects.toBeInstanceOf(PresignError);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("throws PresignError (never a partial URL) when the presigner rejects", async () => {
    vi.stubEnv("CBA_REPORT_BUCKET", BUCKET);
    vi.stubEnv("AWS_REGION", "us-east-1");

    getSignedUrl.mockRejectedValue(new Error("presigner blew up"));

    await expect(presignReport(ACTOR_ID, KEY)).rejects.toBeInstanceOf(PresignError);
  });
});
