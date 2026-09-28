import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';

/** Uploads one part (or object) to a presigned PUT URL, as a real client would, returning its ETag. */
export async function putToPresignedUrl(
  url: string,
  body: Buffer<ArrayBuffer>,
): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body });
  if (!res.ok) {
    throw new Error(
      `Presigned PUT failed with ${res.status}: ${await res.text()}`,
    );
  }
  const etag = res.headers.get('etag');
  if (!etag) {
    throw new Error('Presigned PUT response has no ETag header');
  }
  return etag;
}

function createTestS3Client(): S3Client {
  const config = storageConfig();
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/** Removes every object under `prefix` in the test bucket (one DeleteObject per key). */
export async function deleteObjectsByPrefix(prefix: string): Promise<void> {
  const client = createTestS3Client();
  const { bucket } = storageConfig();
  try {
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) {
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
          );
        }
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
  } finally {
    client.destroy();
  }
}
