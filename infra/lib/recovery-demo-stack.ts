import * as path from "node:path";
import { Stack, Duration, StackProps } from "aws-cdk-lib";
import { Runtime, Architecture } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export class RecoveryDemoStack extends Stack {
  public readonly shipmentsQueue: Queue;
  public readonly shipmentsDlq: Queue;
  public readonly shipmentProcessor: NodejsFunction;

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

    this.shipmentProcessor = new NodejsFunction(this, "ShipmentProcessor", {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      entry: path.join(__dirname, "../../src/processor/handler.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
      },
    });

    this.shipmentProcessor.addEventSource(
      new SqsEventSource(this.shipmentsQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );
  }
}
