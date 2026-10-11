export const DEMO_STACK_NAME = "TamingDlqsDemoStack";
export const QUEUE_URL_OUTPUT = "ShipmentsQueueUrl";
export const DLQ_URL_OUTPUT = "ShipmentsDlqUrl";
export const LEDGER_TABLE_OUTPUT = "DemoLedgerTableName";
export const RECOVERY_ALIAS_OUTPUT = "RecoveryLiveAliasArn";
export const RECOVERY_LIVE_ALIAS = "live";
export const EXPECTED_DLQ_DEPTH = 4;

// EventBridge failure path (same four-class story, different transport).
// A rule delivers shipment events to a Lambda target. The processor writes a
// failed initial delivery, as the EventBridge event, onto an SQS dead-letter
// queue, and the same durable recovery job replays them back onto the bus.
export const EVENT_BUS_NAME_OUTPUT = "ShipmentEventBusName";
export const EVENT_DLQ_URL_OUTPUT = "ShipmentEventsDlqUrl";

// SNS failure path. A topic fans out to a Lambda subscription. The processor
// writes a failed initial delivery, as an SNS Notification, onto the SQS
// notifications DLQ. The same durable recovery job republishes them onto the
// topic. Unlike
// EventBridge, SNS carries per-message attributes, so recovery provenance rides
// as message attributes (like the SQS path).
export const SNS_TOPIC_ARN_OUTPUT = "ShipmentTopicArn";
export const SNS_DLQ_URL_OUTPUT = "ShipmentNotificationsDlqUrl";

// DynamoDB Streams failure path. Inserts and updates on a shipment table stream
// to a Lambda. The processor writes a failed initial delivery onto an SQS
// dead-letter queue. Recovery invokes that processor with the saved item.
export const SHIPMENT_RECORDS_TABLE_OUTPUT = "ShipmentRecordsTableName";
export const STREAM_DLQ_URL_OUTPUT = "ShipmentStreamDlqUrl";
export const STREAM_PROCESSOR_ARN_OUTPUT = "ShipmentStreamProcessorArn";

/** Source/detail-type used when seeding fresh shipment events onto the bus. */
export const SHIPMENT_EVENT_SOURCE = "fulfilment.shipments";
export const SHIPMENT_EVENT_DETAIL_TYPE = "ShipmentRequested";

/** Source/detail-type the recovery job uses when it replays onto the bus. */
export const RECOVERY_EVENT_SOURCE = "taming-dlqs.recovery";
export const RECOVERY_EVENT_DETAIL_TYPE = "ShipmentRecoveryReplay";

/** Key under an EventBridge event `detail` that carries recovery provenance. */
export const RECOVERY_DETAIL_KEY = "__recovery";
