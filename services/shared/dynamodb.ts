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

/**
 * Atomically increment a numeric counter in DynamoDB.
 * Sets a TTL on first creation using `if_not_exists`.
 * Returns the new counter value.
 */
export async function atomicIncrementCounter(
  tableName: string,
  key: Record<string, unknown>,
  ttlEpochSeconds: number
): Promise<number> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'ADD #count :inc SET #ttl = if_not_exists(#ttl, :ttl)',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':inc': 1, ':ttl': ttlEpochSeconds },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  return (result.Attributes?.count as number) ?? 1;
}

/**
 * Append a single value to a DynamoDB list attribute.
 * Creates the list if it does not exist.
 */
export async function appendToList(
  tableName: string,
  key: Record<string, unknown>,
  attributeName: string,
  value: unknown
): Promise<void> {
  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'SET #attr = list_append(if_not_exists(#attr, :emptyList), :newVal)',
      ExpressionAttributeNames: { '#attr': attributeName },
      ExpressionAttributeValues: { ':newVal': [value], ':emptyList': [] },
    })
  );
}

/**
 * Atomically decrement a numeric counter in DynamoDB using ADD.
 * Returns the new counter value.
 */
export async function atomicDecrement(
  tableName: string,
  key: Record<string, unknown>,
  attributeName: string
): Promise<number> {
  const result = await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: 'ADD #attr :dec',
      ExpressionAttributeNames: { '#attr': attributeName },
      ExpressionAttributeValues: { ':dec': -1 },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  return (result.Attributes?.[attributeName] as number) ?? -1;
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
