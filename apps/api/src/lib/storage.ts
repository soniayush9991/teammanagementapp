import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';
import { ApiError } from './errors.js';

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    const config = env();
    client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  return client;
}

/**
 * Files never pass through the API process. The client asks for a presigned
 * PUT, uploads straight to object storage, then registers the attachment.
 */
const DISALLOWED_EXTENSIONS = new Set(['exe', 'dll', 'bat', 'cmd', 'sh', 'msi', 'scr', 'jar']);

export function assertUploadAllowed(fileName: string, byteSize: number): void {
  if (byteSize > env().UPLOAD_MAX_BYTES) {
    throw ApiError.unprocessable(`File exceeds the ${Math.floor(env().UPLOAD_MAX_BYTES / 1024 / 1024)}MB limit`);
  }
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (DISALLOWED_EXTENSIONS.has(extension)) {
    throw ApiError.unprocessable(`Files of type .${extension} cannot be uploaded`);
  }
}

/** Storage keys are org-scoped and opaque so file names cannot collide or traverse. */
export function buildStorageKey(orgId: string, scope: string, fileName: string): string {
  const safeName = fileName.replace(/[^\w.\-]+/g, '_').slice(-120);
  return `${orgId}/${scope}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}-${safeName}`;
}

export async function presignUpload(
  storageKey: string,
  contentType: string,
  byteSize: number,
): Promise<{ url: string; expiresIn: number }> {
  const expiresIn = 300;
  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: storageKey,
      ContentType: contentType,
      ContentLength: byteSize,
      ServerSideEncryption: 'AES256',
    }),
    { expiresIn },
  );
  return { url, expiresIn };
}

export async function presignDownload(storageKey: string, fileName: string): Promise<string> {
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: storageKey,
      // Force a download rather than letting the browser render an uploaded
      // HTML/SVG file on our origin.
      ResponseContentDisposition: `attachment; filename="${fileName.replace(/["\\]/g, '')}"`,
    }),
    { expiresIn: 300 },
  );
}

export async function deleteObject(storageKey: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: storageKey }));
}
