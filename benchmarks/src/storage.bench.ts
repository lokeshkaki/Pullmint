// benchmarks/src/storage.bench.ts
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
// These benchmarks require a live MinIO instance.
// Skip gracefully when MINIO_ENDPOINT is not set.
import { registerSuite } from './harness';
import { faker } from '@faker-js/faker';

const MINIO_ENDPOINT = process.env['MINIO_ENDPOINT'];

if (MINIO_ENDPOINT) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const s3 = new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env['MINIO_ACCESS_KEY'] ?? 'minioadmin',
      secretAccessKey: process.env['MINIO_SECRET_KEY'] ?? 'minioadmin',
    },
    forcePathStyle: true,
  });

  const BUCKET = 'pullmint-bench';
  const payload100k = Buffer.from(faker.lorem.paragraphs(200).repeat(3)); // ~100KB
  const payload1mb = Buffer.alloc(1_000_000, 'x');
  const stableKey = `bench/stable-${faker.string.uuid()}.diff`;

  registerSuite({
    name: 'storage',
    iterations: 30,
    tasks: [
      {
        name: 'MinIO putObject — 100KB diff',
        tags: ['io'],
        fn: async () => {
          await s3.send(
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: `bench/diff-${faker.string.uuid()}.diff`,
              Body: payload100k,
              ContentType: 'text/plain',
            })
          );
        },
      },
      {
        name: 'MinIO getObject — retrieve 100KB diff',
        tags: ['io'],
        setup: async () => {
          await s3.send(
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: stableKey,
              Body: payload100k,
              ContentType: 'text/plain',
            })
          );
        },
        fn: async () => {
          const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: stableKey }));
          // Drain the stream to measure full download time
          await res.Body?.transformToString();
        },
      },
      {
        name: 'MinIO putObject — 1MB analysis result',
        tags: ['io'],
        fn: async () => {
          await s3.send(
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: `bench/result-${faker.string.uuid()}.json`,
              Body: payload1mb,
              ContentType: 'application/json',
            })
          );
        },
      },
    ],
  });
}
