import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { generateEmbedding } from '../embeddings';

const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => bedrockMock.reset());

describe('generateEmbedding', () => {
  it('returns a 1536-dimension float array from Titan response', async () => {
    const fakeVector = new Array(1536).fill(0.1);
    const responseBody = JSON.stringify({ embedding: fakeVector });
    bedrockMock.on(InvokeModelCommand).resolves({
      body: Buffer.from(responseBody),
    });

    const result = await generateEmbedding('hello world');
    expect(result).toHaveLength(1536);
    expect(result[0]).toBeCloseTo(0.1);
  });

  it('propagates Bedrock errors', async () => {
    bedrockMock.on(InvokeModelCommand).rejects(new Error('Bedrock unavailable'));
    await expect(generateEmbedding('test')).rejects.toThrow('Bedrock unavailable');
  });
});
