import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DomainError } from "./core.js";

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

const allowedMimeTypes = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm",
  "application/pdf", "application/zip", "application/x-zip-compressed",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain", "text/csv",
]);

export interface MediaUploadInput {
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256?: string;
}

export interface MediaObjectHead {
  byteSize: number;
  mimeType: string;
}

export function validateMediaInput(input: MediaUploadInput): MediaUploadInput {
  const filename = input.filename.replace(/\\/g, "/").split("/").at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180) || "attachment";
  const mimeType = input.mimeType.toLowerCase().split(";", 1)[0].trim();
  const byteSize = Number(input.byteSize);
  if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_MEDIA_BYTES) throw new DomainError(400, `Attachment size must be between 1 byte and ${MAX_MEDIA_BYTES} bytes`, "invalid_attachment_size");
  if (!allowedMimeTypes.has(mimeType)) throw new DomainError(400, `Unsupported attachment type: ${mimeType || "unknown"}`, "unsupported_attachment_type");
  if (input.sha256 && !/^[a-f0-9]{64}$/i.test(input.sha256)) throw new DomainError(400, "sha256 must be a 64-character hexadecimal digest", "invalid_attachment_hash");
  return { filename, mimeType, byteSize, sha256: input.sha256?.toLowerCase() };
}

export class MediaStorage {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly publicClient: S3Client;

  constructor() {
    this.bucket = process.env.S3_BUCKET || "botcrm-media";
    const credentials = {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.MINIO_ROOT_USER || "botcrm",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.MINIO_ROOT_PASSWORD || "botcrm_dev_secret",
    };
    const common = {
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || "true") !== "false",
      credentials,
    };
    const internalEndpoint = process.env.S3_ENDPOINT || process.env.MINIO_ENDPOINT || "http://localhost:9000";
    this.client = new S3Client({ ...common, endpoint: internalEndpoint });
    this.publicClient = new S3Client({ ...common, endpoint: process.env.S3_PUBLIC_ENDPOINT || internalEndpoint });
  }

  async createUploadUrl(objectKey: string, mimeType: string) {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, ContentType: mimeType });
    return getSignedUrl(this.publicClient, command, { expiresIn: 15 * 60 });
  }

  async head(objectKey: string): Promise<MediaObjectHead> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return { byteSize: Number(result.ContentLength ?? 0), mimeType: String(result.ContentType ?? "").toLowerCase().split(";", 1)[0] };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) throw new DomainError(409, "Uploaded object was not found in media storage", "media_object_missing");
      throw new DomainError(503, "Media storage is temporarily unavailable", "media_storage_unavailable");
    }
  }

  async createDownloadUrl(objectKey: string, filename?: string) {
    const safe = (filename || "attachment").replace(/["\r\n]/g, "_");
    return getSignedUrl(this.publicClient, new GetObjectCommand({ Bucket: this.bucket, Key: objectKey, ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(safe)}` }), { expiresIn: 5 * 60 });
  }

  async remove(objectKey: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }
}
