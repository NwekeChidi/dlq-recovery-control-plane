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
  resolveShipmentRecordsTableName,
  resolveStreamDlqUrl,
} from "./aws";
import {
  resetDemoEnvironment,
  seedStreamDemo,
  setDemoDownstream,
  startStreamRecovery,
  waitForRecoveryTerminal,
  waitForSeededStreamDlq,
} from "./demo-ops";

async function main(): Promise<void> {
  const circuitBreaker = process.argv.includes("--circuit-breaker");
  console.log(
    circuitBreaker
      ? "Smoke (DynamoDB Streams): circuit-breaker STOP"
      : "Smoke (DynamoDB Streams): healthy recovery",
  );

  await resetDemoEnvironment();
  console.log("Reset complete");

  const tableName = await resolveShipmentRecordsTableName();
  console.log(`Shipment table: ${tableName}`);
  const seeded = await seedStreamDemo();
  for (const item of seeded) {
    console.log(item.shipmentId);
  }

  const reachedDlq = await waitForSeededStreamDlq();
  if (!reachedDlq) {
    throw new Error(`Timed out waiting for ShipmentStreamDLQ depth ${EXPECTED_DLQ_DEPTH}`);
  }
  console.log(`ShipmentStreamDLQ reached ${EXPECTED_DLQ_DEPTH}`);

  if (circuitBreaker) {
    await setDemoDownstream(DownstreamStatus.Broken);
    console.log("Downstream: broken");
  }

  try {
    const recoveryId = await startStreamRecovery();
    console.log(`Started DynamoDB stream recovery: ${recoveryId}`);

    const finished = await waitForRecoveryTerminal(recoveryId);
    if (!finished) {
      throw new Error(`Timed out waiting for recovery ${recoveryId} to complete or stop`);
    }

    const snapshot = await loadSnapshot(recoveryId);
    const problems = circuitBreaker
      ? evaluateStoppedSmoke(snapshot)
      : evaluateHealthySmoke(snapshot);

    const streamDlqUrl = await resolveStreamDlqUrl();
    const ledger = await resolveDemoLedger();
    const recovery = await resolveDemoRecoveryStore();
    const [dlq, shipments, quarantines, recoveryJobs, recoveryMessages, downstreamStatus] =
      await Promise.all([
        getQueueDepth(streamDlqUrl),
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
        { queue: null, dlq: "ShipmentStreamDLQ" },
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
  const streamDlqUrl = await resolveStreamDlqUrl();
  const recovery = await resolveDemoRecoveryStore();
  const [dlq, job, messages] = await Promise.all([
    getQueueDepth(streamDlqUrl),
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
