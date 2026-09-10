import * as path from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import {
  DLQ_URL_OUTPUT,
  LEDGER_TABLE_OUTPUT,
  QUEUE_URL_OUTPUT,
} from "../../src/shared/demo";

export class RecoveryDemoStack extends Stack {
  public readonly shipmentsQueue: Queue;
  public readonly shipmentsDlq: Queue;
  public readonly shipmentProcessor: NodejsFunction;
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
  }
}
