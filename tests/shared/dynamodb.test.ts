import {
  CONFIG_PK,
  isConfigPk,
  isQuarantinePk,
  isRecoveryJobPk,
  isRecoveryMessagePk,
  parseRecoveryMessagePk,
  quarantinePk,
  recoveryJobPk,
  recoveryMessagePk,
} from "../../src/shared/dynamodb";

describe("demo ledger keys", () => {
  test("quarantine and recovery keys are distinct prefixes", () => {
    expect(quarantinePk("msg-003")).toBe("QUARANTINE#msg-003");
    expect(recoveryJobPk("rec-1")).toBe("RECOVERY#rec-1");
    expect(recoveryMessagePk("rec-1", "msg-003")).toBe("RECOVERY#rec-1#MSG#msg-003");

    expect(isQuarantinePk("QUARANTINE#msg-003")).toBe(true);
    expect(isRecoveryJobPk("RECOVERY#rec-1")).toBe(true);
    expect(isRecoveryJobPk("RECOVERY#rec-1#MSG#msg-003")).toBe(false);
    expect(isRecoveryMessagePk("RECOVERY#rec-1#MSG#msg-003")).toBe(true);
    expect(parseRecoveryMessagePk("RECOVERY#rec-1#MSG#msg-003")).toEqual({
      recoveryId: "rec-1",
      messageId: "msg-003",
    });
    expect(CONFIG_PK).toBe("CONFIG#DEMO");
    expect(isConfigPk("CONFIG#DEMO")).toBe(true);
    expect(isConfigPk("RECOVERY#rec-1")).toBe(false);
  });
});
