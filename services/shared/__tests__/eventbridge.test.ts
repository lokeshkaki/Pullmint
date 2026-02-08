import { mockClient } from 'aws-sdk-client-mock';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { publishEvent } from '../eventbridge';

const eventBridgeMock = mockClient(EventBridgeClient);

describe('EventBridge Client', () => {
  beforeEach(() => {
    eventBridgeMock.reset();
  });

  describe('publishEvent', () => {
    it('should publish event to EventBridge', async () => {
      const eventBusName = 'pullmint-events';
      const source = 'pullmint.github';
      const detailType = 'pr.opened';
      const detail = {
        prNumber: 123,
        repoFullName: 'owner/repo',
        author: 'testuser',
      };

      eventBridgeMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 0,
        Entries: [{ EventId: 'test-event-id' }],
      });

      await publishEvent(eventBusName, source, detailType, detail);

      expect(eventBridgeMock.calls()).toHaveLength(1);
      const call = eventBridgeMock.call(0);
      const input = call.args[0].input;

      expect(input.Entries).toHaveLength(1);
      expect(input.Entries[0]).toEqual({
        EventBusName: eventBusName,
        Source: source,
        DetailType: detailType,
        Detail: JSON.stringify(detail),
      });
    });

    it('should stringify complex detail objects', async () => {
      const eventBusName = 'test-bus';
      const source = 'test.source';
      const detailType = 'test.event';
      const detail = {
        nested: {
          deep: {
            value: 'test',
          },
          array: [1, 2, 3],
        },
        timestamp: Date.now(),
      };

      eventBridgeMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 0,
        Entries: [{ EventId: 'event-123' }],
      });

      await publishEvent(eventBusName, source, detailType, detail);

      const call = eventBridgeMock.call(0);
      const publishedDetail = (call.args[0].input as any).Entries[0].Detail;

      expect(typeof publishedDetail).toBe('string');
      expect(JSON.parse(publishedDetail)).toEqual(detail);
    });

    it('should handle empty detail object', async () => {
      const eventBusName = 'test-bus';
      const source = 'test.source';
      const detailType = 'test.event';
      const detail = {};

      eventBridgeMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 0,
        Entries: [{ EventId: 'event-456' }],
      });

      await publishEvent(eventBusName, source, detailType, detail);

      const call = eventBridgeMock.call(0);
      const publishedDetail = (call.args[0].input as any).Entries[0].Detail;

      expect(publishedDetail).toBe('{}');
    });

    it('should propagate EventBridge errors', async () => {
      const eventBusName = 'test-bus';
      const source = 'test.source';
      const detailType = 'test.event';
      const detail = { test: 'value' };

      eventBridgeMock.on(PutEventsCommand).rejects(new Error('ResourceNotFoundException'));

      await expect(publishEvent(eventBusName, source, detailType, detail)).rejects.toThrow(
        'ResourceNotFoundException'
      );
    });

    it('should handle different event types', async () => {
      const eventBusName = 'pullmint-events';
      const testCases = [
        {
          source: 'pullmint.github',
          detailType: 'pr.opened',
          detail: { prNumber: 1 },
        },
        {
          source: 'pullmint.github',
          detailType: 'pr.synchronize',
          detail: { prNumber: 2 },
        },
        {
          source: 'pullmint.analysis',
          detailType: 'analysis.completed',
          detail: { executionId: 'exec-123' },
        },
      ];

      eventBridgeMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 0,
        Entries: [{ EventId: 'event-id' }],
      });

      for (const testCase of testCases) {
        await publishEvent(eventBusName, testCase.source, testCase.detailType, testCase.detail);
      }

      expect(eventBridgeMock.calls()).toHaveLength(3);

      // Verify each call had correct parameters
      testCases.forEach((testCase, index) => {
        const call = eventBridgeMock.call(index);
        const entry = (call.args[0].input as any).Entries[0];
        expect(entry.Source).toBe(testCase.source);
        expect(entry.DetailType).toBe(testCase.detailType);
        expect(JSON.parse(entry.Detail)).toEqual(testCase.detail);
      });
    });

    it('should handle failed events', async () => {
      const eventBusName = 'test-bus';
      const source = 'test.source';
      const detailType = 'test.event';
      const detail = { test: 'value' };

      eventBridgeMock.on(PutEventsCommand).resolves({
        FailedEntryCount: 1,
        Entries: [
          {
            ErrorCode: 'InternalException',
            ErrorMessage: 'Event failed to publish',
          },
        ],
      });

      // publishEvent should now throw an error when events fail to publish
      await expect(publishEvent(eventBusName, source, detailType, detail)).rejects.toThrow(
        'Failed to publish 1 event(s)'
      );
    });
  });
});
