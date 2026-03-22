import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

let s3Client: S3Client | null = null;
const initializedBuckets = new Set<string>();

export function getStorageClient(): S3Client {
  if (!s3Client) {
    const endpoint = process.env.MINIO_ENDPOINT || 'http://localhost:9000';
    s3Client = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
      },
      forcePathStyle: true,
    });
  }

  return s3Client;
}

export async function ensureBucket(bucketName: string): Promise<void> {
  if (initializedBuckets.has(bucketName)) {
    return;
  }

  const client = getStorageClient();

  try {
    await client.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
  }

  initializedBuckets.add(bucketName);
}

export async function putObject(bucket: string, key: string, body: string): Promise<void> {
  await ensureBucket(bucket);

  const client = getStorageClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    })
  );
}

export async function getObject(bucket: string, key: string): Promise<string> {
  const client = getStorageClient();
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  return await response.Body!.transformToString();
}
