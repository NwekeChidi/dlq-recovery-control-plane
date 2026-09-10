import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { RecoveryDemoStack } from "../../infra/lib/recovery-demo-stack";

describe("RecoveryDemoStack", () => {
  const template = Template.fromStack(
    new RecoveryDemoStack(new cdk.App(), "TestStack"),
  );

  test("creates the source queue and DLQ", () => {
    template.resourceCountIs("AWS::SQS::Queue", 2);
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

  test("creates a durable recovery function invoked through the live alias", () => {
    template.resourceCountIs("AWS::Lambda::Function", 2);
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
});
