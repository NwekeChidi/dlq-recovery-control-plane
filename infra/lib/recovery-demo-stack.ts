import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class RecoveryDemoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Phase 0 intentionally defines no AWS resources.
    //
    // Phase 1 will add:
    // - OrdersQueue
    // - OrdersDLQ
    // - OrderProcessor Lambda
  }
}
