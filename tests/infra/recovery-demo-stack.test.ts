import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { RecoveryDemoStack } from "../../infra/lib/recovery-demo-stack";

describe("RecoveryDemoStack", () => {
  const template = Template.fromStack(
    new RecoveryDemoStack(new cdk.App(), "TestStack"),
  );

  test("creates the source queue, its DLQ, and the EventBridge + SNS target DLQs", () => {
    template.resourceCountIs("AWS::SQS::Queue", 4);
  });

  test("source queue redrives to the DLQ after two receives", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      VisibilityTimeout: 30,
      RedrivePolicy: {
        maxReceiveCount: 2,
        deadLetterTargetArn: Match.anyValue(),
      },
    });
  });

  test("processor is an ARM64 Node.js 24 function", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Timeout: 10,
      Handler: "index.handler",
    });
  });

  test("maps the source queue to the processor one message at a time", () => {
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      EventSourceArn: Match.anyValue(),
    });
  });

  test("grants the processor permission to consume from SQS", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "sqs:ReceiveMessage",
              "sqs:DeleteMessage",
              "sqs:GetQueueAttributes",
            ]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  test("exports queue URLs, ledger table name, and recovery alias for demo CLI scripts", () => {
    template.hasOutput("ShipmentsQueueUrl", {});
    template.hasOutput("ShipmentsDlqUrl", {});
    template.hasOutput("DemoLedgerTableName", {});
    template.hasOutput("RecoveryLiveAliasArn", {});
  });

  test("wires an EventBridge failure path: bus, rule, target DLQ, and outputs", () => {
    template.resourceCountIs("AWS::Events::EventBus", 1);
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        source: ["fulfilment.shipments", "taming-dlqs.recovery"],
        "detail-type": ["ShipmentRequested", "ShipmentRecoveryReplay"],
      },
    });
    template.hasOutput("ShipmentEventBusName", {});
    template.hasOutput("ShipmentEventsDlqUrl", {});
  });

  test("gives the EventBridge rule target a dead-letter queue with limited retries", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Targets: Match.arrayWith([
        Match.objectLike({
          DeadLetterConfig: { Arn: Match.anyValue() },
          RetryPolicy: Match.objectLike({
            MaximumRetryAttempts: 2,
            MaximumEventAgeInSeconds: 900,
          }),
        }),
      ]),
    });
  });

  test("lets the recovery function replay onto the bus (events:PutEvents)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "events:PutEvents",
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  test("wires an SNS failure path: topic, Lambda subscription with DLQ, and outputs", () => {
    template.resourceCountIs("AWS::SNS::Topic", 1);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
      RedrivePolicy: Match.anyValue(),
    });
    template.hasOutput("ShipmentTopicArn", {});
    template.hasOutput("ShipmentNotificationsDlqUrl", {});
  });

  test("lets the recovery function republish onto the topic (sns:Publish)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sns:Publish",
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  test("creates a durable recovery function plus SQS, EventBridge, and SNS processors", () => {
    template.resourceCountIs("AWS::Lambda::Function", 4);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Timeout: 60,
      DurableConfig: {
        ExecutionTimeout: 3600,
        RetentionPeriodInDays: 7,
      },
    });
    template.hasResourceProperties("AWS::Lambda::Alias", {
      Name: "live",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Timeout: 60,
      Environment: {
        Variables: {
          SHIPMENTS_QUEUE_URL: Match.anyValue(),
          SHIPMENTS_DLQ_URL: Match.anyValue(),
        },
      },
    });
  });

  test("creates a pay-per-request dispatch ledger", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        {
          AttributeName: "pk",
          AttributeType: "S",
        },
      ],
      KeySchema: [
        {
          AttributeName: "pk",
          KeyType: "HASH",
        },
      ],
    });
  });

  test("enables DynamoDB TTL on the expiresAt attribute", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TimeToLiveSpecification: {
        AttributeName: "expiresAt",
        Enabled: true,
      },
    });
  });
});
