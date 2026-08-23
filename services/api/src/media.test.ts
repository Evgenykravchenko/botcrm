import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./core.js";
import { MAX_MEDIA_BYTES, MediaStorage, validateMediaInput } from "./media.js";

test("media validation normalizes safe metadata", () => {
  assert.deepEqual(validateMediaInput({ filename: "../invoice.PDF", mimeType: "APPLICATION/PDF; charset=binary", byteSize: 2048 }), {
    filename: "invoice.PDF",
    mimeType: "application/pdf",
    byteSize: 2048,
    sha256: undefined,
  });
});

test("media validation rejects unsupported and oversized files", () => {
  assert.throws(() => validateMediaInput({ filename: "run.exe", mimeType: "application/x-msdownload", byteSize: 10 }), (error: unknown) => error instanceof DomainError && error.code === "unsupported_attachment_type");
  assert.throws(() => validateMediaInput({ filename: "large.pdf", mimeType: "application/pdf", byteSize: MAX_MEDIA_BYTES + 1 }), (error: unknown) => error instanceof DomainError && error.code === "invalid_attachment_size");
});

test("S3 upload URLs are short-lived and contain the reserved object key", async () => {
  const storage = new MediaStorage();
  const url = await storage.createUploadUrl("workspace/2026/08/test document.pdf", "application/pdf");
  assert.match(url, /^https?:\/\//);
  assert.match(url, /X-Amz-Expires=900/);
  assert.match(decodeURIComponent(url), /test document\.pdf/);
});
