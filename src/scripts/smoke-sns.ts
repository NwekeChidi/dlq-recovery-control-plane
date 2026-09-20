import { EXPECTED_DLQ_DEPTH } from "../shared/demo";
import {
  evaluateHealthySmoke,
  evaluateStoppedSmoke,
  formatTalkSummary,
  type SmokeSnapshot,
} from "../shared/demo-smoke";
import { formatDemoStatus } from "../shared/demo-status";
import { DownstreamStatus } from "../shared/recovery";
import {
  formatDemoAwsError,
  getQueueDepth,
  resolveDemoLedger,
  resolveDemoRecoveryStore,
  resolveSnsDlqUrl,
  resolveSnsTopicArn,
} from "./aws";
import {
  resetDemoEnvironment,
  seedSnsDemo,
  setDemoDownstream,
  startSnsRecovery,
  waitForRecoveryTerminal,
  waitForSeededSnsDlq,
} from "./demo-ops";

async function main(): Promise<void> {
  const circuitBreaker = process.argv.includes("--circuit-breaker");
  console.log(
    circuitBreaker ? "Smoke (SNS): circuit-breaker STOP" : "Smoke (SNS): healthy recovery",
  );

  await resetDemoEnvironment();
  console.log("Reset complete");

  const topicArn = await resolveSnsTopicArn();
  console.log(`SNS topic: ${topicArn}`);
  const seeded = await seedSnsDemo();
  for (const item of seeded) {
    console.log(`${item.shipmentId}  ${item.messageId}`);
  }

  const reachedDlq = await waitForSeededSnsDlq();
  if (!reachedDlq) {
    throw new Error(`Timed out waiting for ShipmentNotificationsDLQ depth ${EXPECTED_DLQ_DEPTH}`);
  }
  console.log(`ShipmentNotificationsDLQ reached ${EXPECTED_DLQ_DEPTH}`);

  if (circuitBreaker) {
    await setDemoDownstream(DownstreamStatus.Broken);
    console.log("Downstream: broken");
  }

  try {
    const recoveryId = await startSnsRecovery();
    console.log(`Started SNS recovery: ${recoveryId}`);

    const finished = await waitForRecoveryTerminal(recoveryId);
    if (!finished) {
      throw new Error(`Timed out waiting for recovery ${recoveryId} to complete or stop`);
    }

    const snapshot = await loadSnapshot(recoveryId);
    const problems = circuitBreaker
      ? evaluateStoppedSmoke(snapshot)
      : evaluateHealthySmoke(snapshot);

    const snsDlqUrl = await resolveSnsDlqUrl();
    const ledger = await resolveDemoLedger();
    const recovery = await resolveDemoRecoveryStore();
    const [dlq, shipments, quarantines, recoveryJobs, recoveryMessages, downstreamStatus] =
      await Promise.all([
        getQueueDepth(snsDlqUrl),
        ledger.listShipmentStates(),
        recovery.listQuarantines(),
        recovery.listRecoveryJobs(),
        recovery.listRecoveryMessages(),
        recovery.getDownstreamStatus(),
      ]);

    console.log("");
    console.log(
      formatDemoStatus(
        { visible: 0, inFlight: 0 },
        dlq,
        shipments,
        { quarantines, recoveryJobs, recoveryMessages, downstreamStatus },
        { queue: null, dlq: "ShipmentNotificationsDLQ" },
      ),
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
  const snsDlqUrl = await resolveSnsDlqUrl();
  const recovery = await resolveDemoRecoveryStore();
  const [dlq, job, messages] = await Promise.all([
    getQueueDepth(snsDlqUrl),
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
