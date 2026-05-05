import { IGovernanceEventHandler, GovernanceEvent } from "../governance-types";
import { Logger, LoggerProvider } from "@hyperledger/cactus-common";
import {
  EXPECTED_POLICY_KEYS,
  PolicyKey,
  RuntimePolicy,
  parsePolicyEntry,
} from "../governance-policy-config";
import { SATPGateway } from "../../plugin-satp-hermes-gateway";

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
    this.log.info(
      `${fnTag}: Applying policy update — key=${key} parsed=${JSON.stringify(
        parsedPolicy,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      )}`,
    );
    await this.gateway.applyPolicyConfig(parsedPolicy);

    this.log.info(`${fnTag}: Policy key '${key}' updated successfully`);
  }
}