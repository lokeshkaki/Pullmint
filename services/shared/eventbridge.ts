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
  await eventBridgeClient.send(
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
}
