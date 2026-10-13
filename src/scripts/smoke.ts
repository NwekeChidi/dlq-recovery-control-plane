import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import {
  evaluateHealthySmoke,
  evaluateStoppedSmoke,
  formatTalkSummary,
  type SmokeSnapshot,
} from "../shared/demo-smoke";
import { formatDemoStatus, SQS_DLQ_LABEL, STREAM_DLQ_LABEL } from "../shared/demo-status";
import { DownstreamStatus } from "../shared/recovery";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoQueueUrls,
  resolveDemoRecoveryStore,
  streamDlqVisible,
} from "./aws";
import {
  resetDemoEnvironment,
  seedDemoShipments,
  setDemoDownstream,
  startDemoRecovery,
  waitForRecoveryTerminal,
  waitForSeededDlq,
} from "./demo-ops";

async function main(): Promise<void> {
  const circuitBreaker = process.argv.includes("--circuit-breaker");
  console.log(circuitBreaker ? "Smoke: circuit-breaker STOP" : "Smoke: healthy recovery");

  await resetDemoEnvironment();
  console.log("Reset complete");

  const seeded = await seedDemoShipments();
  for (const item of seeded) {
    console.log(`${item.shipmentId}  ${item.messageId}`);
  }

  const reachedDlq = await waitForSeededDlq();
  if (!reachedDlq) {
    throw new Error(`Timed out waiting for ${SQS_DLQ_LABEL} depth ${EXPECTED_DLQ_DEPTH}`);
  }
  console.log(`${SQS_DLQ_LABEL} reached ${EXPECTED_DLQ_DEPTH}`);

  if (circuitBreaker) {
    await setDemoDownstream(DownstreamStatus.Broken);
    console.log("Downstream: broken");
  }

  try {
    const recoveryId = await startDemoRecovery();
    console.log(`Started recovery: ${recoveryId}`);

    const finished = await waitForRecoveryTerminal(recoveryId);
    if (!finished) {
      throw new Error(`Timed out waiting for recovery ${recoveryId} to complete or stop`);
    }

    const snapshot = await loadSnapshot(recoveryId);
    const problems = circuitBreaker
      ? evaluateStoppedSmoke(snapshot)
      : evaluateHealthySmoke(snapshot);

    const urls = await resolveDemoQueueUrls();
    const ledger = await resolveDemoLedger();
    const recovery = await resolveDemoRecoveryStore();
    const [queue, dlq, shipments, quarantines, recoveryJobs, recoveryMessages, downstreamStatus] =
      await Promise.all([
        getQueueDepth(urls.queueUrl),
        getQueueDepth(urls.dlqUrl),
        ledger.listShipmentStates(),
        recovery.listQuarantines(),
        recovery.listRecoveryJobs(),
        recovery.listRecoveryMessages(),
        recovery.getDownstreamStatus(),
      ]);

    console.log("");
    console.log(
      formatDemoStatus(queue, dlq, shipments, {
        extraQueues: [{ label: STREAM_DLQ_LABEL, visible: await streamDlqVisible() }],
        quarantines,
        recoveryJobs,
        recoveryMessages,
        downstreamStatus,
      }),
    );
    console.log("");
    console.log(formatTalkSummary(snapshot));

    if (problems.length > 0) {
      console.error("");
      console.error("FAIL");
      for (const problem of problems) {
        console.error(`  ${problem}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("");
    console.log("PASS");
  } finally {
    if (circuitBreaker) {
      await setDemoDownstream(DownstreamStatus.Healthy);
      console.log("");
      console.log("Downstream restored to healthy");
    }
  }
}

async function loadSnapshot(recoveryId: string): Promise<SmokeSnapshot> {
  const urls = await resolveDemoQueueUrls();
  const recovery = await resolveDemoRecoveryStore();
  const [dlq, job, messages] = await Promise.all([
    getQueueDepth(urls.dlqUrl),
    recovery.getRecoveryJob(recoveryId),
    recovery.listRecoveryMessages(recoveryId),
  ]);
  return {
    dlqVisible: dlq.visible,
    job: job
      ? {
          recoveryId: job.recoveryId,
          status: job.status,
          stopReason: job.stopReason,
          processedCount: job.processedCount,
        }
      : undefined,
    messages,
  };
}

main().catch((error: unknown) => {
  console.error(formatDemoAwsError(error));
  process.exitCode = 1;
});
