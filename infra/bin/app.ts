#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";
import { RecoveryDemoStack } from "../lib/recovery-demo-stack";

const app = new cdk.App();

new RecoveryDemoStack(app, "TamingDlqsDemoStack", {
  description:
    "Conference demo infrastructure for Taming Dead-Letter Queues: Triage, Patch, and Replay",
});
