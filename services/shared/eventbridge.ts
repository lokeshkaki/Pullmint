import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const eventBridgeClient = new EventBridgeClient({});

/**
 * Publish an event to EventBridge
 */
export async function publishEvent(
  eventBusName: string,
  source: string,
  detailType: string,
  detail: Record<string, unknown>
): Promise<void> {
  const result = await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: eventBusName,
          Source: source,
          DetailType: detailType,
          Detail: JSON.stringify(detail),
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
