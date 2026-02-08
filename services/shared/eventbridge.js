"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publishEvent = publishEvent;
const client_eventbridge_1 = require("@aws-sdk/client-eventbridge");
const eventBridgeClient = new client_eventbridge_1.EventBridgeClient({});
/**
 * Publish an event to EventBridge
 */
async function publishEvent(eventBusName, source, detailType, detail) {
    await eventBridgeClient.send(new client_eventbridge_1.PutEventsCommand({
        Entries: [
            {
                EventBusName: eventBusName,
                Source: source,
                DetailType: detailType,
                Detail: JSON.stringify(detail),
            },
        ],
    }));
}
