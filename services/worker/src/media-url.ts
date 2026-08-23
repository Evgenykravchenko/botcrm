import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | undefined;

function storageClient() {
  if (client) return client;
  const endpoint = process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT;
  client = new S3Client({
    region: process.env.S3_REGION ?? "us-east-1",
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.MINIO_ROOT_USER ?? "botcrm",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.MINIO_ROOT_PASSWORD ?? "botcrm_dev_secret",
    },
  });
  return client;
}

export async function attachmentUrl(objectKey: string, filename: string) {
  return getSignedUrl(storageClient(), new GetObjectCommand({ Bucket: process.env.S3_BUCKET ?? "botcrm-media", Key: objectKey, ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(filename)}` }), { expiresIn: 900 });
}
