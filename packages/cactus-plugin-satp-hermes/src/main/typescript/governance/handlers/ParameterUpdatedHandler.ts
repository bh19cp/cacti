import { IGovernanceEventHandler, GovernanceEvent } from "../governance-types";
import { Logger, LoggerProvider } from "@hyperledger/cactus-common";
import {
  EXPECTED_POLICY_KEYS,
  PolicyKey,
  RuntimePolicy,
  parsePolicyEntry,
} from "../governance-policy-config";
import { SATPGateway } from "../../plugin-satp-hermes-gateway";

import { GovernancePerfRecorder } from "../../../../test/typescript/integration/governance/utils/governancePerfRecorder";
export class ParameterUpdatedHandler implements IGovernanceEventHandler {
  public static readonly CLASS_NAME = "ParameterUpdatedHandler";

  public readonly id = "ParameterUpdatedHandler";
  public readonly interestedEvents = [
    "ParameterUpdated(string,uint256,uint256,uint256)",
  ];

  private readonly log: Logger;

  constructor(private readonly gateway: SATPGateway) {
    this.log = LoggerProvider.getOrCreate({
      label: ParameterUpdatedHandler.CLASS_NAME,
      level: "INFO",
    });
  }

  async handle(event: GovernanceEvent): Promise<void> {
    const fnTag = `${ParameterUpdatedHandler.CLASS_NAME}#handle()`;
    const eventReceivedNs = Date.now();

    this.log.debug(
      `${fnTag}: Received event:\n${JSON.stringify(event, null, 2)}`,
    );

    const key = event.params["key"] as string;
    const newValue = event.params["newValue"] as string;

    if (!key || newValue === undefined) {
      this.log.warn(`${fnTag}: Missing key or newValue in event — skipping`);
      return;
    }

    if (!EXPECTED_POLICY_KEYS.includes(key as PolicyKey)) {
      this.log.warn(`${fnTag}: Unknown policy key '${key}' — skipping`);
      return;
    }

    let parsedPolicy: Partial<RuntimePolicy>;
    try {
      parsedPolicy = parsePolicyEntry(key as PolicyKey, BigInt(newValue));
    } catch (err) {
      this.log.error(
        `${fnTag}: Failed to parse key=${key} value=${newValue}: ${err}`,
      );
      return;
    }

    const applyStartNs = Date.now();

    await this.gateway.applyPolicyConfig(parsedPolicy);

    const applyEndNs = Date.now();

    this.log.info(`${fnTag}: Policy key '${key}' updated successfully`);

    const recorder = GovernancePerfRecorder.get();
    if (recorder) {
      recorder.record({
        run: recorder.nextRun(),
        gatewayId: this.gateway.Identity.id,
        key,
        newValue,
        eventReceivedNs,
        applyStartNs,
        applyEndNs,
      });
    }
  }
}
