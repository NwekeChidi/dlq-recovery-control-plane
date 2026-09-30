# Taming Dead-Letter Queues

Conference demo for **Taming Dead-Letter Queues: A Serverless Framework for Triage, Patch, and Replay**.

A DLQ captures failure. It does not provide recovery.

This repo is a shipment-fulfilment playground: four deterministic failures land on an SQS DLQ, then an explicit durable recovery job triages, patches, quarantines, replays, observes, and stops if replay is unsafe.

## Prerequisites

- Node.js 24
- AWS credentials (`aws login`, or an AWS profile)
- A bootstrapped CDK environment in the target account/region

```bash
npm install
npm test
```

## Deploy

```bash
npm run deploy
```

Redeploy after code changes so the live processor and `live` recovery alias pick them up.

## Reset

```bash
npm run demo:reset
```

Purges both queues, clears the demo ledger, and restores downstream to `healthy`.

SQS allows purge only once per 60 seconds. If reset fails for that reason, wait a minute and retry. Do not use the Console between rehearsal runs.

## Seed

```bash
npm run demo:seed
```

Sends SHP-001 through SHP-004 and waits until the DLQ has 4 messages.

## Inspect

```bash
npm run demo:status
```

Projector-friendly queue, downstream, quarantine, and recovery summary. Use a large terminal font.

## Recover

```bash
npm run recovery:start
```

Starts the durable recovery job asynchronously and prints `Started recovery: REC-...`. Wait about 15 seconds, then inspect:

```bash
npm run demo:status
```

Healthy outcome:

```text
SHP-001  recovered
SHP-002  patched + recovered
SHP-003  quarantined
SHP-004  duplicate suppressed
Status   COMPLETED
```

## Break downstream

```bash
npm run demo:break-downstream
npm run recovery:start
npm run demo:status
```

Authorized replays fail. Recovery should stop itself:

```text
Status:        STOPPED
Stop reason:   Replay failure rate ... exceeded maxFailureRate 0.25
```

## Restore downstream

```bash
npm run demo:restore-downstream
```

`demo:reset` also restores healthy.

## Smoke

End-to-end check against the deployed stack (reset → seed → recover → assert):

```bash
npm run demo:smoke
npm run demo:smoke -- --circuit-breaker
```

Prints `PASS` or `FAIL`. The circuit-breaker run restores downstream even when the assertion fails.

## EventBridge and SNS failure paths

Two more fully deployed failure paths prove the control plane is source-agnostic. Each delivers to a Lambda that can fail; failed deliveries redrive to an SQS dead-letter queue, and the **same** durable recovery job drains that DLQ and replays back onto the original transport. The four fixtures (SHP-001..004) exercise the same triage → patch → replay → quarantine → skip story through every transport.

EventBridge — a bus delivers shipment events to a Lambda target; failures redrive to `ShipmentEventsDLQ`; recovery replays via `PutEvents`:

```bash
npm run demo:seed:eb       # PutEvents SHP-001..004; target fails; wait until ShipmentEventsDLQ has 4
npm run demo:status:eb     # bus name + ShipmentEventsDLQ depth + ledger + recovery projection
npm run recovery:start:eb  # recover the EventBridge path (replayTarget=eventbridge, replays onto the bus)
npm run demo:status:eb     # after (~15s); expect the DLQ drained and Status COMPLETED
npm run demo:smoke:eb                       # end-to-end reset → seed → recover → assert
npm run demo:smoke:eb -- --circuit-breaker  # STOP path
```

SNS — a topic fans out to a Lambda subscription. The processor writes a failed initial delivery, as an SNS notification, to `ShipmentNotificationsDLQ`. Recovery republishes via `Publish` (provenance rides as message attributes):

```bash
npm run demo:seed:sns       # Publish SHP-001..004; processor dead-letters them; wait until ShipmentNotificationsDLQ has 4
npm run demo:status:sns     # topic ARN + ShipmentNotificationsDLQ depth + ledger + recovery projection
npm run recovery:start:sns  # recover the SNS path (replayTarget=sns, republishes onto the topic)
npm run demo:status:sns     # after (~15s); expect the DLQ drained and Status COMPLETED
npm run demo:smoke:sns                       # end-to-end reset → seed → recover → assert
npm run demo:smoke:sns -- --circuit-breaker  # STOP path
```

The recovery function chooses its DLQ and replay target per run from the start event, so one deployed durable function recovers the SQS, EventBridge, or SNS path. `demo:reset` purges the EventBridge and SNS DLQs too. Kinesis / DynamoDB Streams / Lambda async destinations use the same shape but stay conceptual.

## Destroy

```bash
npm run destroy
```

## Slides

28-minute AWS Community deck (no company branding): open [slides/index.html](slides/index.html). For Google Slides, upload [slides/taming-dead-letter-queues.pptx](slides/taming-dead-letter-queues.pptx) to Drive and Open with Google Slides. Keys and fallbacks: [slides/README.md](slides/README.md).

## Talk sequence

```bash
npm run demo:reset
npm run demo:seed
npm run demo:status
npm run recovery:start
npm run demo:status
```

Failure-mode beat:

```bash
npm run demo:reset
npm run demo:seed
npm run demo:break-downstream
npm run recovery:start
npm run demo:status
npm run demo:restore-downstream
```
