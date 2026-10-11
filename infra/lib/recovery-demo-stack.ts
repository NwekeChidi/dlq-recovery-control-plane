import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, StreamViewType, Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Alias, Architecture, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource, SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import {
  DLQ_URL_OUTPUT,
  EVENT_BUS_NAME_OUTPUT,
  EVENT_DLQ_URL_OUTPUT,
  LEDGER_TABLE_OUTPUT,
  QUEUE_URL_OUTPUT,
  RECOVERY_ALIAS_OUTPUT,
  RECOVERY_EVENT_DETAIL_TYPE,
  RECOVERY_EVENT_SOURCE,
  RECOVERY_LIVE_ALIAS,
  SHIPMENT_EVENT_DETAIL_TYPE,
  SHIPMENT_EVENT_SOURCE,
  SHIPMENT_RECORDS_TABLE_OUTPUT,
  SNS_DLQ_URL_OUTPUT,
  SNS_TOPIC_ARN_OUTPUT,
  STREAM_DLQ_URL_OUTPUT,
  STREAM_PROCESSOR_ARN_OUTPUT,
} from "../../src/shared/demo";

export class RecoveryDemoStack extends Stack {
  public readonly shipmentsQueue: Queue;
  public readonly shipmentsDlq: Queue;
  public readonly shipmentProcessor: NodejsFunction;
  public readonly recoveryFunction: NodejsFunction;
  public readonly recoveryLiveAlias: Alias;
  public readonly demoLedger: Table;
  public readonly shipmentEventBus: EventBus;
  public readonly shipmentEventsDlq: Queue;
  public readonly eventBridgeProcessor: NodejsFunction;
  public readonly shipmentTopic: Topic;
  public readonly shipmentNotificationsDlq: Queue;
  public readonly snsProcessor: NodejsFunction;
  public readonly shipmentRecords: Table;
  public readonly shipmentStreamDlq: Queue;
  public readonly streamProcessor: NodejsFunction;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.shipmentsDlq = new Queue(this, "ShipmentsDLQ", {
      retentionPeriod: Duration.days(14),
    });

    this.shipmentsQueue = new Queue(this, "ShipmentsQueue", {
      visibilityTimeout: Duration.seconds(30),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        maxReceiveCount: 2,
        queue: this.shipmentsDlq,
      },
    });

    this.demoLedger = new Table(this, "DemoLedger", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      // Job + per-message records carry an `expiresAt` (epoch seconds) and are
      // reaped by DynamoDB TTL; quarantined originals opt out by omitting it.
      timeToLiveAttribute: "expiresAt",
    });

    this.shipmentProcessor = new NodejsFunction(this, "ShipmentProcessor", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      entry: path.join(__dirname, "../../src/processor/handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        DEMO_LEDGER_TABLE_NAME: this.demoLedger.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
      },
    });

    this.demoLedger.grantReadWriteData(this.shipmentProcessor);

    this.shipmentProcessor.addEventSource(
      new SqsEventSource(this.shipmentsQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    this.recoveryFunction = new NodejsFunction(this, "ShipmentRecovery", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      entry: path.join(__dirname, "../../src/recovery/handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(60),
      memorySize: 256,
      durableConfig: {
        executionTimeout: Duration.hours(1),
        retentionPeriod: Duration.days(7),
      },
      environment: {
        DEMO_LEDGER_TABLE_NAME: this.demoLedger.tableName,
        SHIPMENTS_DLQ_URL: this.shipmentsDlq.queueUrl,
        SHIPMENTS_QUEUE_URL: this.shipmentsQueue.queueUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
      },
    });

    this.demoLedger.grantReadWriteData(this.recoveryFunction);
    this.shipmentsDlq.grantConsumeMessages(this.recoveryFunction);
    this.shipmentsQueue.grantSendMessages(this.recoveryFunction);

    this.recoveryLiveAlias = new Alias(this, "RecoveryLiveAlias", {
      aliasName: RECOVERY_LIVE_ALIAS,
      version: this.recoveryFunction.currentVersion,
    });

    // EventBridge failure path: a rule delivers shipment events to a Lambda
    // target. EventBridge invokes Lambda asynchronously and does not write a
    // thrown handler to the target DLQ, so the processor writes the failed
    // event itself onto ShipmentEventsDLQ. Recovery (replayTarget=eventbridge)
    // drains that queue and puts the events back on the bus.
    this.shipmentEventBus = new EventBus(this, "ShipmentEventBus");

    this.shipmentEventsDlq = new Queue(this, "ShipmentEventsDLQ", {
      retentionPeriod: Duration.days(14),
    });

    this.eventBridgeProcessor = new NodejsFunction(this, "ShipmentEventProcessor", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      entry: path.join(__dirname, "../../src/processor/eventbridge-handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        DEMO_LEDGER_TABLE_NAME: this.demoLedger.tableName,
        SHIPMENT_EVENTS_DLQ_URL: this.shipmentEventsDlq.queueUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
      },
    });

    this.demoLedger.grantReadWriteData(this.eventBridgeProcessor);
    this.shipmentEventsDlq.grantSendMessages(this.eventBridgeProcessor);

    new Rule(this, "ShipmentEventsRule", {
      eventBus: this.shipmentEventBus,
      eventPattern: {
        source: [SHIPMENT_EVENT_SOURCE, RECOVERY_EVENT_SOURCE],
        detailType: [SHIPMENT_EVENT_DETAIL_TYPE, RECOVERY_EVENT_DETAIL_TYPE],
      },
      targets: [
        new LambdaFunction(this.eventBridgeProcessor, {
          deadLetterQueue: this.shipmentEventsDlq,
          retryAttempts: 2,
          maxEventAge: Duration.minutes(15),
        }),
      ],
    });

    // Recovery drains the EventBridge target DLQ and replays back onto the bus.
    this.shipmentEventsDlq.grantConsumeMessages(this.recoveryFunction);
    this.shipmentEventBus.grantPutEventsTo(this.recoveryFunction);

    // SNS failure path: a topic fans out to a Lambda subscription. SNS does not
    // redrive a thrown handler to the subscription DLQ, so the processor writes
    // the failed delivery itself, as an SNS Notification, onto
    // ShipmentNotificationsDLQ. Recovery (replayTarget=sns) drains that queue
    // and republishes onto the topic.
    this.shipmentTopic = new Topic(this, "ShipmentTopic");

    this.shipmentNotificationsDlq = new Queue(this, "ShipmentNotificationsDLQ", {
      retentionPeriod: Duration.days(14),
    });

    this.snsProcessor = new NodejsFunction(this, "ShipmentNotificationProcessor", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      entry: path.join(__dirname, "../../src/processor/sns-handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        DEMO_LEDGER_TABLE_NAME: this.demoLedger.tableName,
        SHIPMENT_NOTIFICATIONS_DLQ_URL: this.shipmentNotificationsDlq.queueUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
      },
    });

    this.demoLedger.grantReadWriteData(this.snsProcessor);
    this.shipmentNotificationsDlq.grantSendMessages(this.snsProcessor);

    this.shipmentTopic.addSubscription(
      new LambdaSubscription(this.snsProcessor, {
        deadLetterQueue: this.shipmentNotificationsDlq,
      }),
    );

    // Recovery drains the SNS subscription DLQ and republishes onto the topic.
    this.shipmentNotificationsDlq.grantConsumeMessages(this.recoveryFunction);
    this.shipmentTopic.grantPublish(this.recoveryFunction);

    // DynamoDB Streams failure path. The shipment table is separate from the
    // ledger so ledger writes do not feed this stream. A stream has no redrive
    // DLQ, so the processor writes a failed item onto ShipmentStreamDLQ.
    // Recovery (replayTarget=dynamodb) invokes this processor with the saved
    // item and does not write the table again. A thrown replay is retried
    // twice and then dropped so one failure does not pin the shard.
    this.shipmentRecords = new Table(this, "ShipmentRecords", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      stream: StreamViewType.NEW_IMAGE,
    });

    this.shipmentStreamDlq = new Queue(this, "ShipmentStreamDLQ", {
      retentionPeriod: Duration.days(14),
    });

    this.streamProcessor = new NodejsFunction(this, "ShipmentStreamProcessor", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      entry: path.join(__dirname, "../../src/processor/stream-handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        DEMO_LEDGER_TABLE_NAME: this.demoLedger.tableName,
        SHIPMENT_STREAM_DLQ_URL: this.shipmentStreamDlq.queueUrl,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
      },
    });

    this.demoLedger.grantReadWriteData(this.streamProcessor);
    this.shipmentStreamDlq.grantSendMessages(this.streamProcessor);
    this.streamProcessor.addEventSource(
      new DynamoEventSource(this.shipmentRecords, {
        startingPosition: StartingPosition.LATEST,
        batchSize: 1,
        bisectBatchOnError: true,
        retryAttempts: 2,
      }),
    );

    this.recoveryFunction.addEnvironment(
      "SHIPMENT_STREAM_PROCESSOR_ARN",
      this.streamProcessor.functionArn,
    );
    this.shipmentStreamDlq.grantConsumeMessages(this.recoveryFunction);
    this.streamProcessor.grantInvoke(this.recoveryFunction);

    new CfnOutput(this, QUEUE_URL_OUTPUT, {
      value: this.shipmentsQueue.queueUrl,
      description: "Source queue URL for demo:seed / demo:status / demo:reset",
    });

    new CfnOutput(this, DLQ_URL_OUTPUT, {
      value: this.shipmentsDlq.queueUrl,
      description: "DLQ URL for demo:status / demo:reset",
    });

    new CfnOutput(this, LEDGER_TABLE_OUTPUT, {
      value: this.demoLedger.tableName,
      description: "DynamoDB ledger for dispatch, quarantine, and recovery audit",
    });

    new CfnOutput(this, RECOVERY_ALIAS_OUTPUT, {
      value: this.recoveryLiveAlias.functionArn,
      description: "Qualified alias ARN for npm run recovery:start",
    });

    new CfnOutput(this, EVENT_BUS_NAME_OUTPUT, {
      value: this.shipmentEventBus.eventBusName,
      description: "EventBridge bus for demo:seed:eb and EventBridge-path replays",
    });

    new CfnOutput(this, EVENT_DLQ_URL_OUTPUT, {
      value: this.shipmentEventsDlq.queueUrl,
      description: "EventBridge target DLQ URL for demo:status:eb and EventBridge-path recovery",
    });

    new CfnOutput(this, SNS_TOPIC_ARN_OUTPUT, {
      value: this.shipmentTopic.topicArn,
      description: "SNS topic ARN for demo:seed:sns and SNS-path replays",
    });

    new CfnOutput(this, SNS_DLQ_URL_OUTPUT, {
      value: this.shipmentNotificationsDlq.queueUrl,
      description: "SNS subscription DLQ URL for demo:status:sns and SNS-path recovery",
    });

    new CfnOutput(this, SHIPMENT_RECORDS_TABLE_OUTPUT, {
      value: this.shipmentRecords.tableName,
      description: "Shipment table streamed to the stream processor",
    });

    new CfnOutput(this, STREAM_PROCESSOR_ARN_OUTPUT, {
      value: this.streamProcessor.functionArn,
      description: "Stream processor invoked by DynamoDB-path recovery replays",
    });

    new CfnOutput(this, STREAM_DLQ_URL_OUTPUT, {
      value: this.shipmentStreamDlq.queueUrl,
      description: "DynamoDB stream DLQ URL for demo:status:ddb and stream-path recovery",
    });
  }
}
