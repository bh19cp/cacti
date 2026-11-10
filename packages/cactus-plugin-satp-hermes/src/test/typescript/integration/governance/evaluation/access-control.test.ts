import "jest-extended";
import Web3 from "web3";
import {
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import { EthereumTestEnvironment } from "../../../test-utils";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../../environments/ethereum-test-environment";
import {
  DeployDaoResult,
  deployDao,
  delegateOrganizationTokens,
  OrgStatus,
  GatewayStatus,
  DEFAULT_GAS,
  DEFAULT_GAS_PRICE,
} from "../utils/governance-test-utils";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { GovernanceConfig } from "../governance-config/governance-config";

import {
  Web3SigningCredential,
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";

import {
  encodeRegisterOrganization,
  encodeSetOrganizationStatus,
  encodeRemoveOrganization,
  encodeSetParameter,
  encodeSetGatewayStatus,
  encodeRegisterGateway,
  encodeRemoveGateway,
  encodeAddParameter,
  encodeRemoveParameter,
  encodeReclaimTokensToAddress,
  encodeBurnAllTokensFromAccount,
} from "../utils/governance-encode-utils";
import GovernanceWithTimelockContract from "../../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";
import { bufArray2HexStr } from "../../../../../main/typescript";

const TIMEOUT = 12_000_000;
const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Access Control Tests",
});

let ethereumEnv: EthereumTestEnvironment;
let dao: DeployDaoResult;
let web3: InstanceType<typeof Web3>;
let organizationsCredentials: Web3SigningCredentialPrivateKeyHex[] = [];

let ORG_A: { address: string; privateKey: string; name: string };
let ORG_B: { address: string; privateKey: string; name: string };
let ORG_C: { address: string; privateKey: string; name: string };

const DAO_CONFIG: GovernanceConfig = {
  name: "GatewayDAO",
  tokenomics: {
    name: "GovernanceToken",
    symbol: "GOV",
    supply: 1_000_000,
    defaultMemberTokens: 1000,
  },
  organizations: [],
  governance: {
    votingSystem: "token-based",
    votingDelay: 1,
    votingPeriod: 5,
    proposalThreshold: 1,
    quorumFraction: 0,
  },
  timelock: { enabled: true, minDelay: 0 },
  protocolParameters: [
    { key: "satp.version", value: "v02" },
    { key: "satp.session.lockExpirationTime", value: "34" },
    { key: "signingAlgorithm", value: "UNSPECIFIED" },
    { key: "claimFormat", value: "2" },
  ],
};

function extractRevertData(err: any): string | undefined {
  return [
    err?.data,
    err?.cause?.data,
    err?.innerError?.data,
    err?.cause?.innerError?.data,
    err?.cause?.error?.data,
  ].find((c) => typeof c === "string" && c.startsWith("0x"));
}

async function expectDirectWriteToFail(
  credential: Web3SigningCredential,
  target: string,
  calldata: string,
  label: string,
  expectedError?: string,
): Promise<void> {
  if (credential.type !== Web3SigningCredentialType.PrivateKeyHex) {
    throw new Error(
      `expectDirectWriteToFail needs a PrivateKeyHex credential, got ${credential.type}`,
    );
  }
  const pk = credential as Web3SigningCredentialPrivateKeyHex;
  web3.eth.accounts.wallet.add(pk.secret);

  let revertData: string | undefined;
  let simulationReverted = false;
  try {
    await web3.eth.call({
      from: pk.ethAccount,
      to: target,
      data: calldata,
      gas: DEFAULT_GAS.toString(),
    });
  } catch (err: any) {
    simulationReverted = true;
    revertData = extractRevertData(err);
    log.info(
      `[direct write] ${label} -> revert selector: ${revertData?.slice(0, 10) ?? "none"}`,
    );
  }
  if (!simulationReverted) {
    throw new Error(`Direct write "${label}" did not revert in simulation`);
  }

  if (expectedError) {
    const expectedSelector = web3.utils.keccak256(expectedError).slice(0, 10);
    expect({ label, selector: revertData?.slice(0, 10) }).toEqual({
      label,
      selector: expectedSelector,
    });
  }
  let rejected = false;
  try {
    const receipt = await web3.eth.sendTransaction({
      from: pk.ethAccount,
      to: target,
      data: calldata,
      gas: DEFAULT_GAS.toString(),
      gasPrice: DEFAULT_GAS_PRICE,
    });
    rejected = !receipt.status;
  } catch (err) {
    log.debug(`[direct write] ${label} rejected as expected: ${err}`);
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`Direct write "${label}" unexpectedly succeeded`);
  }
}

function encodeGovernorCall(name: string, params: unknown[]): string {
  const fn = (GovernanceWithTimelockContract.abi as any[]).find(
    (f) => f.type === "function" && f.name === name,
  );
  if (!fn) throw new Error(`Governor ABI has no function "${name}"`);
  return web3.eth.abi.encodeFunctionCall(fn, params as any[]);
}

beforeAll(async () => {
  ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
    { logLevel },
    [
      {
        assetType: SupportedEthereumContractTypes.FUNGIBLE,
        contractName: "SATPContract",
      },
      {
        assetType: SupportedEthereumContractTypes.NONFUNGIBLE,
        contractName: "SATPNFTContract",
      },
    ],
  );
  await ethereumEnv.deployAndSetupContracts(1);
  web3 = (ethereumEnv.connector as any).web3;

  const accA = await ethereumEnv.ledger.createEthTestAccount();
  const accB = await ethereumEnv.ledger.createEthTestAccount();
  const accC = await ethereumEnv.ledger.createEthTestAccount();

  organizationsCredentials = [accA, accB, accC].map((a) => ({
    ethAccount: a.address,
    secret: a.privateKey,
    type: Web3SigningCredentialType.PrivateKeyHex,
  }));

  ORG_A = {
    address: accA.address,
    name: "Organization A",
    privateKey: accA.privateKey,
  };
  ORG_B = {
    address: accB.address,
    name: "Organization B",
    privateKey: accB.privateKey,
  };
  ORG_C = {
    address: accC.address,
    name: "Organization C",
    privateKey: accC.privateKey,
  };

  const gwKey = () =>
    bufArray2HexStr(Secp256k1Keys.generateKeyPairsBuffer().publicKey);

  DAO_CONFIG.organizations = [
    {
      address: ORG_A.address,
      name: ORG_A.name,
      gateways: [{ publicKey: gwKey(), name: "Gateway A" }],
      reputation: 1000,
    },
    {
      address: ORG_B.address,
      name: ORG_B.name,
      gateways: [{ publicKey: gwKey(), name: "Gateway B" }],
      reputation: 1000,
    },
    {
      address: ORG_C.address,
      name: ORG_C.name,
      gateways: [{ publicKey: gwKey(), name: "Gateway C" }],
      reputation: 1000,
    },
  ];

  dao = await deployDao(ethereumEnv, DAO_CONFIG);
  await delegateOrganizationTokens(
    ethereumEnv,
    dao.addresses.token,
    organizationsCredentials,
  );
}, TIMEOUT);

afterAll(async () => {
  if (ethereumEnv) await ethereumEnv.tearDown();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

describe("Access control — direct writes after DAO deployment must fail", () => {
  const getCallers = () => [
    { who: "member ORG_A", credential: organizationsCredentials[0] },
    { who: "deployer", credential: dao.deployerCredentials },
  ];

  it(
    "Governor: governance-only setters reject direct calls",
    async () => {
      const calls: [string, string][] = [
        ["setVotingDelay", encodeGovernorCall("setVotingDelay", [10])],
        ["setVotingPeriod", encodeGovernorCall("setVotingPeriod", [10])],
        [
          "setProposalThreshold",
          encodeGovernorCall("setProposalThreshold", [0]),
        ],
        [
          "updateTimelock",
          encodeGovernorCall("updateTimelock", [ORG_A.address]),
        ],
        [
          "updateQuorumNumerator",
          encodeGovernorCall("updateQuorumNumerator", [100]),
        ],
      ];

      for (const { who, credential } of getCallers()) {
        for (const [name, calldata] of calls) {
          await expectDirectWriteToFail(
            credential,
            dao.addresses.governor,
            calldata,
            `governor.${name} by ${who}`,
            "GovernorOnlyExecutor(address)",
          );
        }
      }
    },
    TIMEOUT,
  );

  it(
    "PolicyRegistry: addParameter / setParameter / removeParameter reject direct calls",
    async () => {
      const calls: [string, string][] = [
        ["addParameter", encodeAddParameter(web3, "directWriteParam", 1n)],
        [
          "setParameter",
          encodeSetParameter(web3, "satp.session.lockExpirationTime", 999n),
        ],
        ["removeParameter", encodeRemoveParameter(web3, "satp.version")],
      ];

      for (const { who, credential } of getCallers()) {
        for (const [name, calldata] of calls) {
          await expectDirectWriteToFail(
            credential,
            dao.addresses.policyRegistry,
            calldata,
            `policyRegistry.${name} by ${who}`,
            "OwnableUnauthorizedAccount(address)",
          );
        }
      }
    },
    TIMEOUT,
  );

  it(
    "GatewayRegistry: organization and gateway mutations reject direct calls",
    async () => {
      const existingGwKey = DAO_CONFIG.organizations[0].gateways[0].publicKey;
      const newOrg = await ethereumEnv.ledger.createEthTestAccount();
      const keypair = Secp256k1Keys.generateKeyPairsBuffer();
      const newGwKey = bufArray2HexStr(keypair.publicKey);

      const calls: [string, string][] = [
        [
          "registerOrganization",
          encodeRegisterOrganization(web3, newOrg.address, "Rogue Org", 1000),
        ],
        [
          "setOrganizationStatus",
          encodeSetOrganizationStatus(
            web3,
            ORG_B.address,
            OrgStatus.Suspended,
            "direct write attempt",
          ),
        ],
        [
          "removeOrganization",
          encodeRemoveOrganization(web3, ORG_B.address, "direct write attempt"),
        ],
        [
          "registerGateway",
          encodeRegisterGateway(web3, newGwKey, ORG_A.address, "rogue-gateway"),
        ],
        [
          "setGatewayStatus",
          encodeSetGatewayStatus(
            web3,
            existingGwKey,
            GatewayStatus.Suspended,
            "direct write attempt",
          ),
        ],
        [
          "removeGateway",
          encodeRemoveGateway(web3, existingGwKey, "direct write attempt"),
        ],
      ];

      for (const { who, credential } of getCallers()) {
        for (const [name, calldata] of calls) {
          await expectDirectWriteToFail(
            credential,
            dao.addresses.gatewayRegistry,
            calldata,
            `gatewayRegistry.${name} by ${who}`,
            "OwnableUnauthorizedAccount(address)",
          );
        }
      }
    },
    TIMEOUT,
  );

  it(
    "Token: reclaim / burn reject direct calls",
    async () => {
      const calls: [string, string][] = [
        [
          "reclaimTokensToAddress",
          encodeReclaimTokensToAddress(web3, ORG_B.address, ORG_A.address),
        ],
        [
          "burnAllTokensFromAccount",
          encodeBurnAllTokensFromAccount(web3, ORG_B.address),
        ],
      ];

      for (const { who, credential } of getCallers()) {
        for (const [name, calldata] of calls) {
          await expectDirectWriteToFail(
            credential,
            dao.addresses.token,
            calldata,
            `token.${name} by ${who}`,
          );
        }
      }
    },
    TIMEOUT,
  );
});
