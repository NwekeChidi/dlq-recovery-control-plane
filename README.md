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
npm run reset
```

Purges `ShipmentsQueue`, `ShipmentsSqsDLQ`, `ShipmentEventsDLQ`, `ShipmentNotificationsDLQ`, and `ShipmentStreamDLQ`, clears the demo ledger and shipment table, and restores downstream to `healthy`.

SQS allows purge only once per 60 seconds. If reset fails for that reason, wait a minute and retry. Do not use the Console between rehearsal runs.

## Seed

```bash
npm run seed:sqs
```

Sends SHP-001 through SHP-004 and waits until `ShipmentsSqsDLQ` has 4 messages.

## Inspect

```bash
npm run status
```

Projector-friendly summary of `ShipmentsQueue`, `ShipmentsSqsDLQ`, `ShipmentEventsDLQ`, `ShipmentNotificationsDLQ`, `ShipmentStreamDLQ`, downstream, quarantine, and recovery. Use a large terminal font.

## Recover

```bash
npm run recovery:start:sqs
```

Starts the durable recovery job asynchronously and prints `Started recovery: REC-...`. Wait about 15 seconds, then inspect:

```bash
npm run status
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
npm run break-downstream
npm run recovery:start:sqs
npm run status
```

Authorized replays fail. Recovery should stop itself:

```text
Status:        STOPPED
Stop reason:   Replay failure rate ... exceeded maxFailureRate 0.25
```

## Restore downstream

```bash
npm run restore-downstream
```

`npm run reset` also restores healthy.

## Smoke

End-to-end check against the deployed stack (reset → seed → recover → assert):

```bash
npm run smoke:sqs
npm run smoke:sqs -- --circuit-breaker
```

Prints `PASS` or `FAIL`. The circuit-breaker run restores downstream even when the assertion fails.

## EventBridge, SNS, and DynamoDB Streams failure paths

Three more fully deployed failure paths prove the control plane is source-agnostic. Each delivers to a Lambda that can fail. None of them has a redrive that preserves the business event, so each processor writes the failed delivery itself. The **same** durable recovery job drains that DLQ and replays back onto the original transport. The four fixtures (SHP-001..004) exercise the same triage → patch → replay → quarantine → skip story through every transport.

EventBridge — a bus delivers shipment events to a Lambda target. The processor writes a failed event to `ShipmentEventsDLQ`. Recovery replays via `PutEvents`:

```bash
npm run seed:eb             # PutEvents SHP-001..004; processor dead-letters them; wait until ShipmentEventsDLQ has 4
npm run status:eb           # bus name + ShipmentEventsDLQ depth + ledger + recovery projection
npm run recovery:start:eb   # recover the EventBridge path (replayTarget=eventbridge, replays onto the bus)
npm run status:eb           # after (~15s); expect the DLQ drained and Status COMPLETED
npm run smoke:eb                       # end-to-end reset → seed → recover → assert
npm run smoke:eb -- --circuit-breaker  # STOP path
```

SNS — a topic fans out to a Lambda subscription. The processor writes a failed initial delivery, as an SNS notification, to `ShipmentNotificationsDLQ`. Recovery republishes via `Publish` (provenance rides as message attributes):

```bash
npm run seed:sns            # Publish SHP-001..004; processor dead-letters them; wait until ShipmentNotificationsDLQ has 4
npm run status:sns          # topic ARN + ShipmentNotificationsDLQ depth + ledger + recovery projection
npm run recovery:start:sns  # recover the SNS path (replayTarget=sns, republishes onto the topic)
npm run status:sns          # after (~15s); expect the DLQ drained and Status COMPLETED
npm run smoke:sns                       # end-to-end reset → seed → recover → assert
npm run smoke:sns -- --circuit-breaker  # STOP path
```

DynamoDB Streams — inserts on a shipment table stream to a Lambda. The processor writes a failed item to `ShipmentStreamDLQ`. Recovery invokes that processor with the saved item (provenance rides on the record as `__recovery`) and does not write the table again:

```bash
npm run seed:ddb              # PutItem SHP-001..004; processor dead-letters them; wait until ShipmentStreamDLQ has 4
npm run status:ddb            # table name + ShipmentStreamDLQ depth + ledger + recovery projection
npm run recovery:start:ddb    # recover the stream path (replayTarget=dynamodb)
npm run status:ddb            # after (~15s); expect the DLQ drained and Status COMPLETED
npm run smoke:ddb                       # end-to-end reset → seed → recover → assert
npm run smoke:ddb -- --circuit-breaker  # STOP path
```

The recovery function chooses its DLQ and replay target per run from the start event, so one deployed durable function recovers the SQS, EventBridge, SNS, or DynamoDB Streams path. `npm run reset` purges those DLQs and clears the shipment table. Kinesis and Lambda async destinations use the same shape but stay conceptual.

## Destroy

```bash
npm run destroy
```

## Slides

28-minute AWS Community deck (no company branding): open [slides/index.html](slides/index.html). Rebuild the deck with `npm run slides:pptx`. For Google Slides, upload [slides/taming-dead-letter-queues.pptx](slides/taming-dead-letter-queues.pptx) to Drive and Open with Google Slides. Keys and fallbacks: [slides/README.md](slides/README.md).

## Talk sequence

```bash
npm run reset
npm run seed:sqs
npm run status
npm run recovery:start:sqs
npm run status
```

Failure-mode beat:

```bash
npm run reset
npm run seed:sqs
npm run break-downstream
npm run recovery:start:sqs
npm run status
npm run restore-downstream
```
