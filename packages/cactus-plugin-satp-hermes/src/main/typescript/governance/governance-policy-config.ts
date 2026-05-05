import { SATP_VERSION, SATP_CRASH_VERSION } from "../core/constants";
import Web3 from "web3";
import {
  ClaimFormat,
  SignatureAlgorithm,
} from "../generated/proto/cacti/satp/v02/common/message_pb";

export interface RuntimePolicy {
  satpVersion: string;
  crashVersion: string;
  lockExpirationTime: bigint;
  signatureAlgorithm: SignatureAlgorithm;
  claimFormat: ClaimFormat;
}

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  satpVersion: SATP_VERSION,
  crashVersion: SATP_CRASH_VERSION,
  lockExpirationTime: BigInt(1000 * 60 * 5),
  signatureAlgorithm: SignatureAlgorithm.ECDSA,
  claimFormat: ClaimFormat.DEFAULT,
};

export const EXPECTED_POLICY_KEYS = [
  "satp.version",
  "satp.crash.version",
  "satp.session.lockExpirationTime",
  "signingAlgorithm",
  "claimFormat",
] as const;
export type PolicyKey = (typeof EXPECTED_POLICY_KEYS)[number];

const POLICY_KEY_TO_FIELD: Record<PolicyKey, keyof RuntimePolicy> = {
  "satp.version": "satpVersion",
  "satp.crash.version": "crashVersion",
  "satp.session.lockExpirationTime": "lockExpirationTime",
  signingAlgorithm: "signatureAlgorithm",
  claimFormat: "claimFormat",
};

const V02_HASH = BigInt(Web3.utils.keccak256("v02"));
const ECDSA = BigInt(Web3.utils.keccak256("ECDSA"));
const EDDSA = BigInt(Web3.utils.keccak256("EDDSA"));
const RSA_HASH = BigInt(Web3.utils.keccak256("RSA"));
const UNSPECIFIED_HASH = BigInt(Web3.utils.keccak256("UNSPECIFIED"));

export function parsePolicyEntry(
  key: PolicyKey,
  rawValue: bigint,
): Partial<RuntimePolicy> {
  const field = POLICY_KEY_TO_FIELD[key];
  let value: RuntimePolicy[keyof RuntimePolicy];

  switch (key) {
    case "satp.session.lockExpirationTime":
      value = BigInt(rawValue); // stays bigint
      break;

    case "claimFormat": {
      const num = Number(rawValue);
      if (!(num in ClaimFormat)) {
        throw new Error(`Invalid claimFormat value: ${rawValue}`);
      }
      value = num as ClaimFormat;
      break;
    }

    case "satp.version":
    case "satp.crash.version":
      if (rawValue === V02_HASH) {
        value = "v02";
        break;
      }
      throw new Error(`Unknown version hash: ${rawValue}`);

    case "signingAlgorithm":
      if (rawValue === UNSPECIFIED_HASH) {
        value = SignatureAlgorithm.UNSPECIFIED;
        break;
      }
      if (rawValue === ECDSA) {
        value = SignatureAlgorithm.ECDSA;
        break;
      }
      if (rawValue === EDDSA) {
        value = SignatureAlgorithm.EDDSA;
        break;
      }
      if (rawValue === RSA_HASH) {
        value = SignatureAlgorithm.RSA;
        break;
      }
      throw new Error(`Unknown signingAlgorithm hash: ${rawValue}`);
  }

  return { [field]: value } as Partial<RuntimePolicy>;
}
