/**
 * Handler for ParameterRemoved governance event:
 * When a governance parameter is removed from the PolicyRegistry, this handler
 * resets the corresponding runtime policy value to its protocol‑defined default.
 * This ensures the gateway always operates with a valid, known configuration
 * even after a parameter is deleted on‑chain.
 */
import { IGovernanceEventHandler, GovernanceEvent } from "../governance-types";
import { Logger, LoggerProvider } from "@hyperledger/cactus-common";
import {
  EXPECTED_POLICY_KEYS,
  PolicyKey,
  RuntimePolicy,
  DEFAULT_RUNTIME_POLICY,
  POLICY_KEY_TO_FIELD,
} from "../governance-policy-config";
import { SATPGateway } from "../../plugin-satp-hermes-gateway";

export class ParameterRemovedHandler implements IGovernanceEventHandler {
  public static readonly CLASS_NAME = "ParameterRemovedHandler";

  public readonly id = "ParameterRemovedHandler";
  public readonly interestedEvents = ["ParameterRemoved(string,uint256)"];

  private readonly log: Logger;

  constructor(private readonly gateway: SATPGateway) {
    this.log = LoggerProvider.getOrCreate({
      label: ParameterRemovedHandler.CLASS_NAME,
      level: "INFO",
    });
  }

  async handle(event: GovernanceEvent): Promise<void> {
    const fnTag = `${ParameterRemovedHandler.CLASS_NAME}#handle()`;
    this.log.debug(
      `${fnTag}: Received event:\n${JSON.stringify(event, null, 2)}`,
    );

    const key = event.params["key"] as string;

    if (!key) {
      this.log.warn(`${fnTag}: Missing 'key' in event — skipping`);
      return;
    }

    if (!EXPECTED_POLICY_KEYS.includes(key as PolicyKey)) {
      this.log.warn(`${fnTag}: Unknown policy key '${key}' — skipping`);
      return;
    }

    const field = POLICY_KEY_TO_FIELD[key as PolicyKey] as keyof RuntimePolicy;
    const defaultValue = DEFAULT_RUNTIME_POLICY[field];

    if (defaultValue === undefined) {
      this.log.error(
        `${fnTag}: Default value missing for key='${key}' — cannot revert`,
      );
      return;
    }

    try {
      const revertedPolicy: Partial<RuntimePolicy> = {
        [field]: defaultValue,
      } as Partial<RuntimePolicy>;

      this.log.info(
        `${fnTag}: Resetting key='${key}' to default: ${JSON.stringify(
          revertedPolicy,
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
        )}`,
      );

      await this.gateway.applyPolicyConfig(revertedPolicy);
      this.log.info(`${fnTag}: Policy key '${key}' reverted to default.`);
    } catch (err) {
      this.log.error(
        `${fnTag}: Failed to revert key='${key}' to default: ${err}`,
      );
    }
  }
}
