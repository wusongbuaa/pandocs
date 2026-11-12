import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import type { AssetStore } from "../ports.js";

export interface S3AssetStoreOptions {
  readonly bucket: string;
  readonly region: string;
  readonly prefix: string;
  readonly endpoint?: string | undefined;
  readonly forcePathStyle?: boolean | undefined;
}

export function createS3AssetStore(options: S3AssetStoreOptions): AssetStore & { destroy(): void } {
  const client = new S3Client({
    region: options.region,
    // The SDK adds checksums of its own by default, and not everything that speaks the S3 API accepts them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle })
  });
  const keyOf = (key: string) => `${options.prefix.replace(/\/+$/u, "")}/${key}`;
  return {
    async put(key, bytes, contentType) {
      await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: keyOf(key), Body: bytes, ContentType: contentType }));
    },
    async get(key) {
      try {
        const output = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: keyOf(key) }));
        if (!output.Body) return null;
        return { bytes: await output.Body.transformToByteArray(), contentType: output.ContentType };
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: keyOf(key) }));
    },
    destroy: () => client.destroy()
  };
}
