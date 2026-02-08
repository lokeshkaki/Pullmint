import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { putItem, getItem, updateItem } from '../dynamodb';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('DynamoDB Client', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  describe('putItem', () => {
    it('should put item to DynamoDB', async () => {
      const tableName = 'TestTable';
      const item = {
        id: 'test-123',
        name: 'Test Item',
        timestamp: Date.now(),
      };

      ddbMock.on(PutCommand).resolves({});

      await putItem(tableName, item);

      expect(ddbMock.calls()).toHaveLength(1);
      const call = ddbMock.call(0);
      expect(call.args[0].input).toEqual({
        TableName: tableName,
        Item: item,
      });
    });

    it('should handle empty item object', async () => {
      const tableName = 'TestTable';
      const item = {};

      ddbMock.on(PutCommand).resolves({});

      await putItem(tableName, item);

      expect(ddbMock.calls()).toHaveLength(1);
    });

    it('should propagate DynamoDB errors', async () => {
      const tableName = 'TestTable';
      const item = { id: 'test' };

      ddbMock.on(PutCommand).rejects(new Error('ConditionalCheckFailedException'));

      await expect(putItem(tableName, item)).rejects.toThrow('ConditionalCheckFailedException');
    });

    it('should handle complex nested objects', async () => {
      const tableName = 'TestTable';
      const item = {
        id: 'complex-123',
        metadata: {
          nested: {
            deep: 'value',
          },
          array: [1, 2, 3],
        },
      };

      ddbMock.on(PutCommand).resolves({});

      await putItem(tableName, item);

      const call = ddbMock.call(0);
      expect((call.args[0].input as any).Item).toEqual(item);
    });
  });

  describe('getItem', () => {
    it('should retrieve item from DynamoDB', async () => {
      const tableName = 'TestTable';
      const key = { id: 'test-123' };
      const expectedItem = {
        id: 'test-123',
        name: 'Test Item',
        value: 42,
      };

      ddbMock.on(GetCommand).resolves({
        Item: expectedItem,
      });

      const result = await getItem(tableName, key);

      expect(result).toEqual(expectedItem);
      expect(ddbMock.calls()).toHaveLength(1);
      const call = ddbMock.call(0);
      expect(call.args[0].input).toEqual({
        TableName: tableName,
        Key: key,
      });
    });

    it('should return null when item not found', async () => {
      const tableName = 'TestTable';
      const key = { id: 'nonexistent' };

      ddbMock.on(GetCommand).resolves({});

      const result = await getItem(tableName, key);

      expect(result).toBeNull();
    });

    it('should handle composite keys', async () => {
      const tableName = 'TestTable';
      const key = {
        pk: 'partition-key',
        sk: 'sort-key',
      };
      const expectedItem = {
        pk: 'partition-key',
        sk: 'sort-key',
        data: 'value',
      };

      ddbMock.on(GetCommand).resolves({
        Item: expectedItem,
      });

      const result = await getItem(tableName, key);

      expect(result).toEqual(expectedItem);
    });

    it('should propagate DynamoDB errors', async () => {
      const tableName = 'TestTable';
      const key = { id: 'test' };

      ddbMock.on(GetCommand).rejects(new Error('ResourceNotFoundException'));

      await expect(getItem(tableName, key)).rejects.toThrow('ResourceNotFoundException');
    });

    it('should handle TypeScript generics correctly', async () => {
      interface TestItem {
        id: string;
        count: number;
      }

      const tableName = 'TestTable';
      const key = { id: 'typed-test' };
      const expectedItem: TestItem = {
        id: 'typed-test',
        count: 5,
      };

      ddbMock.on(GetCommand).resolves({
        Item: expectedItem,
      });

      const result = await getItem<TestItem>(tableName, key);

      expect(result).toEqual(expectedItem);
      expect(result?.count).toBe(5);
    });
  });

  describe('updateItem', () => {
    it('should update item in DynamoDB', async () => {
      const tableName = 'TestTable';
      const key = { id: 'test-123' };
      const updates = {
        status: 'completed',
        updatedAt: 1234567890,
      };

      ddbMock.on(UpdateCommand).resolves({});

      await updateItem(tableName, key, updates);

      expect(ddbMock.calls()).toHaveLength(1);
      const call = ddbMock.call(0);
      const input = call.args[0].input;

      expect(input.TableName).toBe(tableName);
      expect(input.Key).toEqual(key);
      expect(input.UpdateExpression).toBe('SET #attr0 = :val0, #attr1 = :val1');
      expect(input.ExpressionAttributeNames).toEqual({
        '#attr0': 'status',
        '#attr1': 'updatedAt',
      });
      expect(input.ExpressionAttributeValues).toEqual({
        ':val0': 'completed',
        ':val1': 1234567890,
      });
    });

    it('should handle single attribute update', async () => {
      const tableName = 'TestTable';
      const key = { id: 'test' };
      const updates = { status: 'active' };

      ddbMock.on(UpdateCommand).resolves({});

      await updateItem(tableName, key, updates);

      const call = ddbMock.call(0);
      const input = call.args[0].input;

      expect(input.UpdateExpression).toBe('SET #attr0 = :val0');
      expect(input.ExpressionAttributeNames).toEqual({
        '#attr0': 'status',
      });
      expect(input.ExpressionAttributeValues).toEqual({
        ':val0': 'active',
      });
    });

    it('should handle complex value types', async () => {
      const tableName = 'TestTable';
      const key = { id: 'test' };
      const updates = {
        metadata: { nested: 'value' },
        tags: ['tag1', 'tag2'],
        count: 42,
      };

      ddbMock.on(UpdateCommand).resolves({});

      await updateItem(tableName, key, updates);

      const call = ddbMock.call(0);
      const input = call.args[0].input;

      expect(input.ExpressionAttributeValues).toEqual({
        ':val0': { nested: 'value' },
        ':val1': ['tag1', 'tag2'],
        ':val2': 42,
      });
    });

    it('should propagate DynamoDB errors', async () => {
      const tableName = 'TestTable';
      const key = { id: 'test' };
      const updates = { status: 'failed' };

      ddbMock.on(UpdateCommand).rejects(new Error('ValidationException'));

      await expect(updateItem(tableName, key, updates)).rejects.toThrow('ValidationException');
    });

    it('should handle attribute names with reserved keywords', async () => {
      const tableName = 'TestTable';
      const key = { id: 'test' };
      const updates = {
        name: 'Test Name',
        status: 'active',
      };

      ddbMock.on(UpdateCommand).resolves({});

      await updateItem(tableName, key, updates);

      const call = ddbMock.call(0);
      const input = call.args[0].input;

      // Verify attribute names are properly escaped
      expect(input.ExpressionAttributeNames).toEqual({
        '#attr0': 'name',
        '#attr1': 'status',
      });
    });
  });
});
