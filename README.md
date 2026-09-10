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

## Destroy

```bash
npm run destroy
```

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
