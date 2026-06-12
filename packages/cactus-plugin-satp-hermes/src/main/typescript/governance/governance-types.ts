import { LogLevelDesc } from "@hyperledger/cactus-common";
import { INetworkOptions, MonitorService } from "../public-api";
import { RuntimePolicy } from "./governance-policy-config";

export const PolicyRegistryEventSignatures = {
  PARAMETER_UPDATED: "ParameterUpdated(string,uint256,uint256,uint256)",
  PARAMETER_ADDED: "ParameterAdded(string,uint256,uint256)",
  PARAMETER_REMOVED: "ParameterRemoved(string,uint256)",
} as const;

export const GatewayRegistryEventSignatures = {
  ORGANIZATION_REGISTERED: "OrganizationRegistered(address,string,uint256)",
  ORGANIZATION_STATUS_CHANGED:
    "OrganizationStatusChanged(address,uint8,uint8,string)",
  ORGANIZATION_REMOVED: "OrganizationRemoved(address,string)",
  GATEWAY_REGISTERED: "GatewayRegistered(address,address,string,uint256)",
  GATEWAY_STATUS_CHANGED: "GatewayStatusChanged(address,uint8,uint8,string)",
  GATEWAY_REMOVED: "GatewayRemoved(address,string)",
} as const;

export const POLICY_REGISTRY_EVENT_SUBSCRIPTIONS: GovernanceEventSubscription[] =
  [
    {
      eventSignature: PolicyRegistryEventSignatures.PARAMETER_UPDATED,
      paramNames: ["key", "oldValue", "newValue", "timestamp"],
    },
    {
      eventSignature: PolicyRegistryEventSignatures.PARAMETER_ADDED,
      paramNames: ["key", "value", "timestamp"],
    },
    {
      eventSignature: PolicyRegistryEventSignatures.PARAMETER_REMOVED,
      paramNames: ["key", "timestamp"],
    },
  ];

export const GATEWAY_REGISTRY_EVENT_SUBSCRIPTIONS: GovernanceEventSubscription[] =
  [
    {
      eventSignature: GatewayRegistryEventSignatures.ORGANIZATION_REGISTERED,
      paramNames: ["orgAddress", "name", "timestamp"],
    },
    {
      eventSignature:
        GatewayRegistryEventSignatures.ORGANIZATION_STATUS_CHANGED,
      paramNames: ["orgAddress", "oldStatus", "newStatus", "reason"],
    },
    {
      eventSignature: GatewayRegistryEventSignatures.ORGANIZATION_REMOVED,
      paramNames: ["orgAddress", "reason"],
    },
    {
      eventSignature: GatewayRegistryEventSignatures.GATEWAY_REGISTERED,
      paramNames: ["gatewayAddress", "orgWallet", "name", "timestamp"],
    },
    {
      eventSignature: GatewayRegistryEventSignatures.GATEWAY_STATUS_CHANGED,
      paramNames: ["gatewayAddress", "oldStatus", "newStatus", "reason"],
    },
    {
      eventSignature: GatewayRegistryEventSignatures.GATEWAY_REMOVED,
      paramNames: ["gatewayAddress", "reason"],
    },
  ];

export interface ContractInfo {
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
  oracleConfig: INetworkOptions;
  policyRegistry: ContractInfo;
  gatewayRegistry: ContractInfo;
}

export interface BootstrapResult {
  policy: RuntimePolicy;
  missingKeys: string[];
}

export interface OnChainParameter {
  key: string;
  value: string | bigint;
  createdAt: string | bigint;
  updatedAt: string | bigint;
  exists: boolean;
}

export interface OnChainGateway {
  name: string;
  gatewayPubKey: string;
  orgWallet: string;
  status: number; // 0 = Active, 1 = Suspended, 2 = Revoked
  registeredAt: number;
  updatedAt: number;
  exists: boolean;
}

export interface OnChainOrganization {
  name: string;
  wallet: string;
  status: number; // 0 = Active, 1 = Suspended, 2 = Probation 3 = inactive
  registeredAt: string;
  updatedAt: string;
  exists: boolean;
  reputation: string;
}

export interface IGatewayComplianceVerifier {
  /**
   * Checks whether the gateway identified by the given public key
   * is compliant and allowed to initiate transfers.
   * @param publicKey - The gateway's public key (hex string)
   * @returns true if compliant, false otherwise
   */
  isGatewayCompliant(publicKey: string): Promise<boolean>;
}

export interface IGatewayPolicyManager {
  applyPolicyConfig(patch: Partial<RuntimePolicy>): void;
  getRuntimePolicy(): RuntimePolicy;
}

export interface IGatewayPolicyApplier {
  applyPolicyConfig(config: RuntimePolicy): Promise<void>;
}

export enum GatewayStatus {
  Active,
  Suspended,
  Revoked,
}
