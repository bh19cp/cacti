import "jest-extended";
import path from "path";
import Web3 from "web3";
import { v4 as uuidV4 } from "uuid";
import { knex, Knex } from "knex";
import {
  LogLevel,
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { LedgerType, PluginImportType } from "@hyperledger/cactus-core-api";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import {
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import {
  BesuTestEnvironment,
  EthereumTestEnvironment,
} from "../../../test-utils";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../../environments/ethereum-test-environment";
import { SupportedContractTypes as SupportedBesuContractTypes } from "../../../environments/besu-test-environment";
import { GovernanceConfig } from "../governance-config/governance-config";
import {
  deployDao,
  DeployDaoResult,
  delegateOrganizationTokens,
  runSuccessfulVoting,
  GatewayStatus,
} from "../utils/governance-test-utils";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  Address,
  bufArray2HexStr,
  ClaimFormat,
  GatewayIdentity,
  MonitorService,
  PluginFactorySATPGateway,
  SATPGateway,
  SATPGatewayConfig,
} from "../../../../../main/typescript";
import { GovernanceManager } from "../../../../../main/typescript/governance/governance-manager";
import { createMigrationSource } from "../../../../../main/typescript/database/knex-migration-source";
import { knexRemoteInstance } from "../../../../../main/typescript/database/knexfile-remote";
import { knexLocalInstance } from "../../../../../main/typescript/database/knexfile";
import {
  encodeAddParameter,
  encodeSetParameter,
  encodeSetGatewayStatus,
} from "../utils/governance-encode-utils";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../../../main/typescript/core/constants";
import {
  IdentificationCredential,
  SupportedSigningAlgorithms,
} from "../../../../../main/typescript/core/types";
import PolicyRegistryContract from "../../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import { GovernancePerfRecorder } from "../utils/governancePerfRecorder";
import * as fs from "fs";

const TIMEOUT = 900_0000;
let executionStream: fs.WriteStream;
const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Voting Lifecycle Benchmarks",
});

const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

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
  timelock: {
    enabled: true,
    minDelay: 0,
  },
  protocolParameters: [
    { key: "satp.version", value: "v02" },
    { key: "satp.session.lockExpirationTime", value: "34" },
    { key: "signingAlgorithm", value: "ECDSA" },
    { key: "claimFormat", value: "2" },
  ],
};

let besuEnv: BesuTestEnvironment;
let ethereumEnv: EthereumTestEnvironment;

let gatewayEth: SATPGateway;
let gatewayBesu: SATPGateway;
let gatewayEth2: SATPGateway;

let governanceManagerEth: GovernanceManager;
let governanceManagerBesu: GovernanceManager;
let governanceManagerEth2: GovernanceManager;

let knexSourceRemoteClient: Knex;
let knexLocalShared: Knex;

let web3: InstanceType<typeof Web3>;

let daoResult: DeployDaoResult;

let organizationsCredentials: Web3SigningCredentialPrivateKeyHex[];
let ORG_A: { address: string; name: string; privateKey: string };
let ORG_B: { address: string; name: string; privateKey: string };
let ORG_C: { address: string; name: string; privateKey: string };

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 30_000,
  intervalMs = 500,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForCondition(${label}): timed out after ${timeoutMs} ms`,
  );
}

const makeGovernanceManager = () =>
  new GovernanceManager({
    logLevel: LogLevel.DEBUG,
    monitorService,
    oracleConfig: ethereumEnv.createEthereumConfig(),
    policyRegistry: {
      contractAddress: daoResult.addresses.policyRegistry,
      contractAbi: PolicyRegistryContract.abi,
    },
    gatewayRegistry: {
      contractAddress: daoResult.addresses.gatewayRegistry,
      contractAbi: GatewayRegistryContract.abi,
    },
  });

beforeAll(async () => {
  const executionCsvPath = path.join(
    __dirname,
    "evaluation-results",
    "propagation-1.csv",
  );

  fs.mkdirSync(path.dirname(executionCsvPath), { recursive: true });

  executionStream = fs.createWriteStream(executionCsvPath, {
    flags: "a",
  });

  executionStream.write("run,key,proposedValue,executeTimestampMs\n");

  GovernancePerfRecorder.init(
    path.join(__dirname, "evaluation-results", "propagation-2.csv"),
  );

  const erc20TokenContract = "SATPContract";
  const erc721TokenContract = "SATPNFTContract";

  const ontologiesPath = path.join(__dirname, "../../../../ontologies");
  const factory = new PluginFactorySATPGateway({
    pluginImportType: PluginImportType.Local,
  });

  besuEnv = await BesuTestEnvironment.setupTestEnvironment({ logLevel }, [
    {
      assetType: SupportedBesuContractTypes.FUNGIBLE,
      contractName: erc20TokenContract,
    },
    {
      assetType: SupportedBesuContractTypes.NONFUNGIBLE,
      contractName: erc721TokenContract,
    },
  ]);
  log.info("Besu ledger started");
  await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);

  ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
    { logLevel },
    [
      {
        assetType: SupportedEthereumContractTypes.FUNGIBLE,
        contractName: erc20TokenContract,
      },
      {
        assetType: SupportedEthereumContractTypes.NONFUNGIBLE,
        contractName: erc721TokenContract,
      },
    ],
  );
  log.info("Ethereum ledger started");
  await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);

  const migrationSource = await createMigrationSource();
  knexSourceRemoteClient = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource },
  });
  await knexSourceRemoteClient.migrate.latest();

  knexLocalShared = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource },
  });
  await knexLocalShared.migrate.latest();

  web3 = (ethereumEnv.connector as any).web3;

  const ORG_A_account = await ethereumEnv.ledger.createEthTestAccount();
  const ORG_B_account = await ethereumEnv.ledger.createEthTestAccount();
  const ORG_C_account = await ethereumEnv.ledger.createEthTestAccount();

  organizationsCredentials = [
    {
      ethAccount: ORG_A_account.address,
      secret: ORG_A_account.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    },
    {
      ethAccount: ORG_B_account.address,
      secret: ORG_B_account.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    },
    {
      ethAccount: ORG_C_account.address,
      secret: ORG_C_account.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    },
  ];

  ORG_A = {
    address: ORG_A_account.address,
    name: "Organization A",
    privateKey: ORG_A_account.privateKey,
  };
  ORG_B = {
    address: ORG_B_account.address,
    name: "Organization B",
    privateKey: ORG_B_account.privateKey,
  };
  ORG_C = {
    address: ORG_C_account.address,
    name: "Organization C",
    privateKey: ORG_C_account.privateKey,
  };

  const keypairA = Secp256k1Keys.generateKeyPairsBuffer();
  const keypairB = Secp256k1Keys.generateKeyPairsBuffer();
  const keypairC = Secp256k1Keys.generateKeyPairsBuffer();
  DAO_CONFIG.organizations = [
    {
      address: ORG_A_account.address,
      name: ORG_A.name,
      gateways: [
        { publicKey: bufArray2HexStr(keypairA.publicKey), name: "Gateway A" },
      ],
      reputation: 1000,
    },
    {
      address: ORG_B_account.address,
      name: ORG_B.name,
      gateways: [
        { publicKey: bufArray2HexStr(keypairB.publicKey), name: "Gateway B" },
      ],
      reputation: 1000,
    },
    {
      address: ORG_C_account.address,
      name: ORG_C.name,
      gateways: [
        { publicKey: bufArray2HexStr(keypairC.publicKey), name: "Gateway C" },
      ],
      reputation: 1000,
    },
  ];

  daoResult = await deployDao(ethereumEnv, DAO_CONFIG);

  await delegateOrganizationTokens(
    ethereumEnv,
    daoResult.addresses.token,
    organizationsCredentials,
  );

  governanceManagerEth = makeGovernanceManager();
  governanceManagerBesu = makeGovernanceManager();
  governanceManagerEth2 = makeGovernanceManager();

  const besuGatewayIdentity: GatewayIdentity = {
    id: "besu-gateway-bench",
    name: "besu-gateway-bench",
    identificationCredential: {
      pubKey: DAO_CONFIG.organizations[0].gateways[0].publicKey,
      signingAlgorithm: SupportedSigningAlgorithms.SECP256K1,
    } as IdentificationCredential,
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proofId-besu-bench",
    address: "http://localhost" as Address,
    gatewayOapiPort: 6030,
    gatewayServerPort: 6031,
    gatewayClientPort: 6032,
    connectedDLTs: [
      {
        id: BesuTestEnvironment.BESU_NETWORK_ID,
        ledgerType: LedgerType.Besu2X,
      },
    ],
  };

  const ethGatewayIdentity: GatewayIdentity = {
    id: "eth-gateway-bench",
    name: "eth-gateway-bench",
    identificationCredential: {
      pubKey: DAO_CONFIG.organizations[1].gateways[0].publicKey,
      signingAlgorithm: SupportedSigningAlgorithms.SECP256K1,
    } as IdentificationCredential,
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proofId-eth-bench",
    address: "http://localhost" as Address,
    gatewayOapiPort: 6033,
    gatewayServerPort: 6034,
    gatewayClientPort: 6035,
    connectedDLTs: [
      {
        id: EthereumTestEnvironment.ETH_NETWORK_ID,
        ledgerType: LedgerType.Ethereum,
      },
    ],
  };

  const ethGateway2Identity: GatewayIdentity = {
    id: "eth-gateway-bench-2",
    name: "eth-gateway-bench-2",
    identificationCredential: {
      pubKey: DAO_CONFIG.organizations[2].gateways[0].publicKey,
      signingAlgorithm: SupportedSigningAlgorithms.SECP256K1,
    } as IdentificationCredential,
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proofId-eth-bench-2",
    address: "http://localhost" as Address,
    gatewayOapiPort: 6036,
    gatewayServerPort: 6037,
    gatewayClientPort: 6038,
    connectedDLTs: [
      {
        id: EthereumTestEnvironment.ETH_NETWORK_ID,
        ledgerType: LedgerType.Ethereum,
      },
    ],
  };

  gatewayBesu = await factory.create({
    instanceId: uuidV4(),
    logLevel: "DEBUG",
    gid: besuGatewayIdentity,
    keyPair: {
      publicKey: DAO_CONFIG.organizations[0].gateways[0].publicKey,
      privateKey: bufArray2HexStr(keypairA.privateKey),
    },
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [ethGatewayIdentity, ethGateway2Identity],
    ccConfig: {
      oracleConfig: [besuEnv.createBesuConfig()],
      bridgeConfig: [besuEnv.createBesuConfig()],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
    gatewayComplianceVerifier: governanceManagerBesu,
    gatewayPolicyManager: governanceManagerBesu,
  } as SATPGatewayConfig);
  await gatewayBesu.onPluginInit();

  gatewayEth = await factory.create({
    instanceId: uuidV4(),
    logLevel: "DEBUG",
    gid: ethGatewayIdentity,
    keyPair: {
      publicKey: DAO_CONFIG.organizations[1].gateways[0].publicKey,
      privateKey: bufArray2HexStr(keypairB.privateKey),
    },
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [besuGatewayIdentity, ethGateway2Identity],
    ccConfig: {
      oracleConfig: [ethereumEnv.createEthereumConfig()],
      bridgeConfig: [ethereumEnv.createEthereumConfig()],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
    gatewayComplianceVerifier: governanceManagerEth,
    gatewayPolicyManager: governanceManagerEth,
  } as SATPGatewayConfig);
  await gatewayEth.onPluginInit();

  const ethConfig2 = ethereumEnv.createEthereumConfig();
  const eth2OracleConfig = {
    ...ethConfig2,
    networkIdentification: {
      ...ethConfig2.networkIdentification,
      id: "EthereumLedgerTestNetwork-2",
    },
  };

  gatewayEth2 = await factory.create({
    instanceId: uuidV4(),
    logLevel: "DEBUG",
    gid: ethGateway2Identity,
    keyPair: {
      publicKey: DAO_CONFIG.organizations[2].gateways[0].publicKey,
      privateKey: bufArray2HexStr(keypairC.privateKey),
    },
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [besuGatewayIdentity, ethGatewayIdentity],
    ccConfig: {
      oracleConfig: [eth2OracleConfig],
      bridgeConfig: [eth2OracleConfig],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
    gatewayComplianceVerifier: governanceManagerEth2,
    gatewayPolicyManager: governanceManagerEth2,
  } as SATPGatewayConfig);
  await gatewayEth2.onPluginInit();

  await gatewayBesu.getOrCreateHttpServer();
  await gatewayEth.getOrCreateHttpServer();
  await gatewayEth2.getOrCreateHttpServer();

  await governanceManagerEth.start(gatewayEth);
  await governanceManagerBesu.start(gatewayBesu);
  await governanceManagerEth2.start(gatewayEth2);
}, TIMEOUT);

afterAll(async () => {
  const recorder = GovernancePerfRecorder.get();
  if (recorder) await recorder.close();
  GovernancePerfRecorder.reset();

  await Promise.all(
    [governanceManagerEth, governanceManagerBesu, governanceManagerEth2]
      .filter(Boolean)
      .map((gm) => gm.stop()),
  );

  if (besuEnv) await besuEnv.tearDown();
  if (ethereumEnv) await ethereumEnv.tearDown();

  if (knexLocalShared) await knexLocalShared.destroy();
  if (knexSourceRemoteClient) await knexSourceRemoteClient.destroy();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

const LOCK_KEY = "satp.session.lockExpirationTime";

const allManagers = (): [string, GovernanceManager][] => [
  ["Eth", governanceManagerEth],
  ["Besu", governanceManagerBesu],
  ["Eth2", governanceManagerEth2],
];

async function proposeAndExecute(
  calldata: string,
  description: string,
  target: string = daoResult.addresses.policyRegistry,
): Promise<number> {
  const { executeTimestamp } = await runSuccessfulVoting({
    ethereumEnv,
    web3,
    governorAddress: daoResult.addresses.governor,
    timelockAddress: daoResult.addresses.timelock,
    targetAddress: target,
    calldata,
    description,
    organizationsCredentials,
    deployerCredentials: organizationsCredentials[0],
  });
  return executeTimestamp;
}

async function expectLockEverywhere(value: bigint, t0: number, tag: string) {
  await Promise.all(
    allManagers().map(async ([label, gm]) => {
      await waitForCondition(
        () => BigInt(gm.getRuntimePolicy().lockExpirationTime ?? 0) === value,
        60_000,
        200,
        `${tag} ${label}`,
      );
      log.info(`[${tag}] ${label} applied after ${Date.now() - t0} ms`);
    }),
  );
}

describe("R4 — gateways load governance state and apply compatible updates", () => {
  it(
    "loads the on-chain state at startup",
    async () => {
      for (const [label, gm] of allManagers()) {
        const policy = gm.getRuntimePolicy();
        log.info(
          `[startup] ${label} policy: ${JSON.stringify(policy, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
        );
        expect(BigInt(policy.lockExpirationTime ?? 0)).toEqual(34n);
      }
    },
    TIMEOUT,
  );

  it(
    "applies a parameter update",
    async () => {
      const newValue = 600_000n;
      expect(
        BigInt(governanceManagerEth.getRuntimePolicy().lockExpirationTime ?? 0),
      ).not.toEqual(newValue);

      const t0 = await proposeAndExecute(
        encodeSetParameter(web3, LOCK_KEY, newValue),
        "R4: live update of lockExpirationTime",
      );

      await expectLockEverywhere(newValue, t0, "live-update");
      for (const [, gm] of allManagers()) {
        expect(BigInt(gm.getRuntimePolicy().lockExpirationTime ?? 0)).toEqual(
          newValue,
        );
      }
    },
    TIMEOUT,
  );

  it(
    "ignores unknown keys and undecodable values, and keeps working",
    async () => {
      const before = { ...governanceManagerEth.getRuntimePolicy() };

      await proposeAndExecute(
        encodeAddParameter(web3, "unknown.key", 1n),
        "R4: add unknown parameter",
      );
      await proposeAndExecute(
        encodeSetParameter(web3, "claimFormat", 999n),
        "R4: set claimFormat to an invalid value",
      );

      await new Promise((r) => setTimeout(r, 5_000));
      for (const [, gm] of allManagers()) {
        expect({ ...gm.getRuntimePolicy() }).toEqual(before);
      }

      const newValue = 700_000n;
      const t0 = await proposeAndExecute(
        encodeSetParameter(web3, LOCK_KEY, newValue),
        "R4: valid update after invalid ones",
      );
      await expectLockEverywhere(newValue, t0, "after-invalid");
    },
    TIMEOUT,
  );
  const normKey = (k: string) =>
    (k.startsWith("0x") ? k : "0x" + k).toLowerCase();

  it(
    "loads gateway and organization registry state at startup",
    async () => {
      for (const [label, gm] of allManagers()) {
        for (const org of DAO_CONFIG.organizations) {
          const gwKey = normKey(org.gateways[0].publicKey);

          expect({
            label,
            key: gwKey,
            cached: gm.isGatewayCached(gwKey),
          }).toEqual({
            label,
            key: gwKey,
            cached: true,
          });
          expect(gm.getCachedGatewayStatus(gwKey)).toBe(0);
          expect(await gm.isGatewayCompliant(gwKey)).toBe(true);

          const cachedOrg = gm.getCachedOrganization(org.address);
          expect(cachedOrg).toBeDefined();
          expect(cachedOrg!.wallet.toLowerCase()).toBe(
            org.address.toLowerCase(),
          );
        }
        const unknownKey = "0x" + "ab".repeat(33);
        expect(gm.isGatewayCached(unknownKey)).toBe(false);
        expect(await gm.isGatewayCompliant(unknownKey)).toBe(false);
      }
    },
    TIMEOUT,
  );

  it(
    "applies gateway suspension and reactivation to the local view",
    async () => {
      const gwKey = normKey(DAO_CONFIG.organizations[2].gateways[0].publicKey);
      const registry = daoResult.addresses.gatewayRegistry;

      const t0 = await proposeAndExecute(
        encodeSetGatewayStatus(
          web3,
          gwKey,
          GatewayStatus.Suspended,
          "R4: suspend",
        ),
        "R4: suspend gateway C",
        registry,
      );
      await Promise.all(
        allManagers().map(async ([label, gm]) => {
          await waitForCondition(
            () => gm.getCachedGatewayStatus(gwKey) !== 0,
            60_000,
            200,
            `suspend ${label}`,
          );
          log.info(`[suspend] ${label} applied after ${Date.now() - t0} ms`);
          expect(await gm.isGatewayCompliant(gwKey)).toBe(false);
        }),
      );

      await proposeAndExecute(
        encodeSetGatewayStatus(
          web3,
          gwKey,
          GatewayStatus.Active,
          "R4: reactivate",
        ),
        "R4: reactivate gateway C",
        registry,
      );
      await Promise.all(
        allManagers().map(([label, gm]) =>
          waitForCondition(
            () => gm.getCachedGatewayStatus(gwKey) === 0,
            60_000,
            200,
            `reactivate ${label}`,
          ),
        ),
      );
    },
    TIMEOUT,
  );
});
