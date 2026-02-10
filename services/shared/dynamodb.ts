import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

/**
 * Save an item to DynamoDB
 */
export async function putItem(tableName: string, item: Record<string, unknown>): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

/**
 * Get an item from DynamoDB
 */
export async function getItem<T>(
  tableName: string,
  key: Record<string, unknown>
): Promise<T | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: key,
    })
  );

  return (result.Item as T) || null;
}

/**
 * Update an item in DynamoDB
 */
export async function updateItem(
  tableName: string,
  key: Record<string, unknown>,
  updates: Record<string, unknown>
): Promise<void> {
  const updateKeys = Object.keys(updates);

  if (updateKeys.length === 0) {
    // No updates to apply; avoid sending an invalid UpdateExpression like "SET "
    return;
  }

  const updateExpression = updateKeys.map((_k, i) => `#attr${i} = :val${i}`).join(', ');

  const expressionAttributeNames: Record<string, string> = updateKeys.reduce(
    (acc, k, i) => ({ ...acc, [`#attr${i}`]: k }),
    {} as Record<string, string>
  );

  const expressionAttributeValues: Record<string, unknown> = updateKeys.reduce(
    (acc, k, i) => ({ ...acc, [`:val${i}`]: updates[k] }),
    {} as Record<string, unknown>
  );

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${updateExpression}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
}

type ConditionalUpdateOptions = {
  conditionExpression: string;
  conditionAttributeNames?: Record<string, string>;
  conditionAttributeValues?: Record<string, unknown>;
};

/**
 * Update an item in DynamoDB with a condition expression.
 */
export async function updateItemConditional(
  tableName: string,
  key: Record<string, unknown>,
  updates: Record<string, unknown>,
  options: ConditionalUpdateOptions
): Promise<void> {
  const updateKeys = Object.keys(updates);

  if (updateKeys.length === 0) {
    return;
  }

  const updateExpression = updateKeys.map((_k, i) => `#attr${i} = :val${i}`).join(', ');

  const updateAttributeNames: Record<string, string> = updateKeys.reduce(
    (acc, k, i) => ({ ...acc, [`#attr${i}`]: k }),
    {} as Record<string, string>
  );

  const updateAttributeValues: Record<string, unknown> = updateKeys.reduce(
    (acc, k, i) => ({ ...acc, [`:val${i}`]: updates[k] }),
    {} as Record<string, unknown>
  );

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${updateExpression}`,
      ExpressionAttributeNames: {
        ...updateAttributeNames,
        ...(options.conditionAttributeNames || {}),
      },
      ExpressionAttributeValues: {
        ...updateAttributeValues,
        ...(options.conditionAttributeValues || {}),
      },
      ConditionExpression: options.conditionExpression,
    })
  );
}
