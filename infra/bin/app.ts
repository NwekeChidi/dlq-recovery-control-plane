#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";
import { RecoveryDemoStack } from "../lib/recovery-demo-stack";
import { DEMO_STACK_NAME } from "../../src/shared/demo";

const app = new cdk.App();

new RecoveryDemoStack(app, DEMO_STACK_NAME, {
  description:
    "Conference demo infrastructure for Taming Dead-Letter Queues: Triage, Patch, and Replay",
});
