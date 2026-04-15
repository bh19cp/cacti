import { LogLevelDesc } from "@hyperledger/cactus-common";
import { MonitorService, SATPGateway } from "../public-api";
import { OracleAbstract } from "../cross-chain-mechanisms/oracle/oracle-abstract";
import { GatewayPolicyConfig } from "./governance-policy-config";

export interface PolicyRegistryContractConfig {
  contractAddress: string;
  contractAbi: unknown[];
}

export interface GatewayRegistryContractConfig {
  contractAddress: string;
  contractAbi: unknown[];
}

export interface GovernanceEventSubscription {
  eventSignature: string;
  paramNames?: string[];
}

export interface GovernanceEvent {
  eventSignature: string;
  contractAddress: string;
  contractName: string;
  params: Record<string, unknown>;
  raw: string[];
  isBootstrap?: boolean;
}

export interface IGovernanceEventHandler {
  readonly id: string;
  readonly interestedEvents: string[];
  filter?(event: GovernanceEvent): boolean;
  handle(event: GovernanceEvent): Promise<void>;
}

export interface GovernanceManagerOptions {
  logLevel?: LogLevelDesc;
  monitorService: MonitorService;
  gateway: SATPGateway;
  oracle: OracleAbstract;
  policyRegistry: PolicyRegistryContractConfig;
  gatewayRegistry: GatewayRegistryContractConfig;
}

export interface BootstrapResult {
  policyConfig: GatewayPolicyConfig;
  missingKeys: string[];
}
