import { S3Client } from '@aws-sdk/client-s3';
export declare function getStorageClient(): S3Client;
export declare function ensureBucket(bucketName: string): Promise<void>;
export declare function putObject(bucket: string, key: string, body: string): Promise<void>;
export declare function getObject(bucket: string, key: string): Promise<string>;
//# sourceMappingURL=storage.d.ts.map