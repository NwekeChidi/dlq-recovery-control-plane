import {
  DEMO_RECOVERY_BATCH_SIZE,
  DEMO_RECOVERY_MAX_BATCH_SIZE,
  resolveRecoveryKnobs,
} from "../../src/shared/recovery";

describe("resolveRecoveryKnobs", () => {
  test("defaults to the demo batch size and caps SQS receive at 10", () => {
    expect(resolveRecoveryKnobs({})).toMatchObject({
      batchSize: DEMO_RECOVERY_BATCH_SIZE,
      maxFailureRate: 0.25,
      replayDelaySeconds: 5,
    });
    expect(resolveRecoveryKnobs({ batchSize: 99 }).batchSize).toBe(DEMO_RECOVERY_MAX_BATCH_SIZE);
    expect(resolveRecoveryKnobs({ batchSize: 0 }).batchSize).toBe(1);
  });
});
