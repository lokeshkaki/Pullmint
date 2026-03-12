import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const eventBridgeClient = new EventBridgeClient({});

/**
 * Publish an event to EventBridge
 */
const MAX_EVENTBRIDGE_DETAIL_BYTES = 256 * 1024;

export async function publishEvent(
  eventBusName: string,
  source: string,
  detailType: string,
  detail: Record<string, unknown>
): Promise<void> {
  const detailJson = JSON.stringify(detail);
  const detailBytes = Buffer.byteLength(detailJson, 'utf8');
  if (detailBytes > MAX_EVENTBRIDGE_DETAIL_BYTES) {
    throw new Error(
      `EventBridge event detail exceeds 256KB limit (${detailBytes} bytes). ` +
        'Store large payloads in S3 and publish a reference instead.'
    );
  }

  const result = await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: eventBusName,
          Source: source,
          DetailType: detailType,
          Detail: detailJson,
        },
      ],
    })
  );

  if (result.FailedEntryCount && result.FailedEntryCount > 0) {
    throw new Error(
      `Failed to publish ${result.FailedEntryCount} event(s): ${JSON.stringify(result.Entries)}`
    );
  }
}
