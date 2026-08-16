import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { RecoveryDemoStack } from "../../infra/lib/recovery-demo-stack";

describe("RecoveryDemoStack", () => {
  test("P0 stack synthesizes without application resources", () => {
    const app = new cdk.App();

    const stack = new RecoveryDemoStack(app, "TestStack");

    const template = Template.fromStack(stack).toJSON();

    expect(template.Resources ?? {}).toEqual({});
  });
});
