export type SigningAlgorithm = "SECP256K1" | "ED25519";

export interface GatewayPolicyConfig {
  "satp.version": string;
  "satp.crash.version": string;
  "satp.session.lockExpirationTime": number;
  signingAlgorithm: SigningAlgorithm;
  enableCrashRecovery: boolean;
  claimFormat: ClaimFormat;
}

export const EXPECTED_POLICY_KEYS = [
  "satp.version",
  "satp.crash.version",
  "satp.session.lockExpirationTime",
  "signingAlgorithm",
  "enableCrashRecovery",
  "claimFormat",
] as const;

export type PolicyKey = (typeof EXPECTED_POLICY_KEYS)[number];

import Web3 from "web3";
import { ClaimFormat } from "../public-api";

// Pre‑compute hashes of the known string constants
const V02_HASH = BigInt(Web3.utils.keccak256("v02"));
const SECP256K1_HASH = BigInt(Web3.utils.keccak256("SECP256K1"));
const ED25519_HASH = BigInt(Web3.utils.keccak256("ED25519"));

export function parsePolicyValue(
  key: PolicyKey,
  rawValue: bigint,
): GatewayPolicyConfig[PolicyKey] {
  switch (key) {
    case "enableCrashRecovery":
      return rawValue === 1n;

    case "satp.session.lockExpirationTime":
      return Number(rawValue);

    case "claimFormat": {
      const num = Number(rawValue);
      if (!(num in ClaimFormat)) {
        throw new Error(`Invalid claimFormat value: ${rawValue}`);
      }
      return num as ClaimFormat;
    }

    case "satp.version":
    case "satp.crash.version":
      if (rawValue === V02_HASH) {
        return "v02";
      }
      throw new Error(`Unknown version hash: ${rawValue}`);

    case "signingAlgorithm":
      if (rawValue === SECP256K1_HASH) {
        return "SECP256K1";
      }
      if (rawValue === ED25519_HASH) {
        return "ED25519";
      }
      throw new Error(`Unknown signingAlgorithm hash: ${rawValue}`);

    default:
      throw new Error(`Unhandled policy key: ${key}`);
  }
}
