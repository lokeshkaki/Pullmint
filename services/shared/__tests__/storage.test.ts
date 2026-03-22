jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn().mockResolvedValue({
    Body: { transformToString: jest.fn().mockResolvedValue('{"test": true}') },
  });

  return {
    S3Client: jest.fn().mockImplementation(() => ({ send })),
    CreateBucketCommand: jest.fn(),
    HeadBucketCommand: jest.fn(),
    PutObjectCommand: jest.fn(),
    GetObjectCommand: jest.fn(),
  };
});

describe('storage', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.MINIO_ENDPOINT;
  });

  it('should create a singleton S3 client with MinIO config', async () => {
    const { getStorageClient } = await import('../storage');
    const client = getStorageClient();
    expect(client).toBeDefined();

    const s3Module = await import('@aws-sdk/client-s3');
    const S3Client = s3Module.S3Client as jest.Mock;
    expect(S3Client).toHaveBeenCalledWith(expect.objectContaining({ forcePathStyle: true }));
  });

  it('should put and get objects', async () => {
    const { getObject, putObject } = await import('../storage');
    await putObject('test-bucket', 'test-key', '{"data": true}');
    const result = await getObject('test-bucket', 'test-key');
    expect(result).toBe('{"test": true}');
  });
});
