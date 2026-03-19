import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({});
const TITAN_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/**
 * Generate a 1536-dimensional embedding vector using Amazon Titan Text Embeddings v2.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const body = JSON.stringify({ inputText: text });
  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: TITAN_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(body),
    })
  );
  const decoded = JSON.parse(Buffer.from(response.body).toString()) as { embedding: number[] };
  return decoded.embedding;
}
