import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Alias, Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import {
  DLQ_URL_OUTPUT,
  LEDGER_TABLE_OUTPUT,
  QUEUE_URL_OUTPUT,
  RECOVERY_ALIAS_OUTPUT,
  RECOVERY_LIVE_ALIAS,
} from "../../src/shared/demo";

export class RecoveryDemoStack extends Stack {
  public readonly shipmentsQueue: Queue;
  public readonly shipmentsDlq: Queue;
  public readonly shipmentProcessor: NodejsFunction;
  public readonly recoveryFunction: NodejsFunction;
  public readonly recoveryLiveAlias: Alias;
  public readonly demoLedger: Table;

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
  }
}
