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
  EthContractInvocationType,
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
  DEFAULT_GAS,
  DEFAULT_GAS_PRICE,
  DeployDaoResult,
  delegateOrganizationTokens,
  runSuccessfulVoting,
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
import { encodeSetParameter } from "../utils/governance-encode-utils";
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
const RUNS = 50;
const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Voting Lifecycle Benchmarks",
});

const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

const NEW_LOCK_EXPIRATION_MS = BigInt(1000 * 60 * 10);

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

describe("PolicyRegistry — full proposal lifecycle (50 runs)", () => {
  it(
    "should measure propagation time after lockExpirationTime is changed via DAO",
    async () => {
      const lockKey = "satp.session.lockExpirationTime";

      for (let run = 1; run <= RUNS; run++) {
        log.info(`[lockExpirationTime] ── run ${run}/${RUNS} ──`);

        const newValue = NEW_LOCK_EXPIRATION_MS + BigInt(run);
        const lockCalldata = encodeSetParameter(web3, lockKey, newValue);

        const { executeTimestamp } = await runSuccessfulVoting({
          ethereumEnv,
          web3,
          governorAddress: daoResult.addresses.governor,
          timelockAddress: daoResult.addresses.timelock,
          targetAddress: daoResult.addresses.policyRegistry,
          calldata: lockCalldata,
          description: `lockExpirationTime → run ${run}`,
          organizationsCredentials,
          deployerCredentials: organizationsCredentials[0],
        });

        executionStream.write(
          `${run},${lockKey},${newValue.toString()},${executeTimestamp}\n`,
        );

        const onChainResult = await ethereumEnv.connector.invokeContract({
          contract: {
            contractAddress: daoResult.addresses.policyRegistry,
            contractJSON: {
              contractName: "PolicyRegistryContract",
              abi: PolicyRegistryContract.abi,
              bytecode: PolicyRegistryContract.bytecode.object,
            },
          },
          invocationType: EthContractInvocationType.Call,
          web3SigningCredential: daoResult.deployerCredentials,
          methodName: "getValue",
          params: [lockKey],
          gasConfig: {
            gas: DEFAULT_GAS.toString(),
            gasPrice: DEFAULT_GAS_PRICE,
          },
        });
        expect(BigInt(onChainResult.callOutput)).toEqual(newValue);

        const managers: [string, GovernanceManager][] = [
          ["GovernanceManager-Eth", governanceManagerEth],
          ["GovernanceManager-Besu", governanceManagerBesu],
          ["GovernanceManager-Eth2", governanceManagerEth2],
        ];

        await Promise.all(
          managers.map(async ([label, gm]) => {
            await waitForCondition(
              () =>
                BigInt(gm.getRuntimePolicy().lockExpirationTime ?? 0) ===
                newValue,
              60_000,
              500,
              `${label} run ${run}`,
            );
            const propagationMs = Date.now() - executeTimestamp;
            log.info(
              `[run ${run}] Propagation to ${label} — ${propagationMs} ms`,
            );
          }),
        );

        for (const [, gm] of managers) {
          expect(BigInt(gm.getRuntimePolicy().lockExpirationTime ?? 0)).toEqual(
            newValue,
          );
        }

        log.info(`[lockExpirationTime] run ${run}/${RUNS} done`);
      }
    },
    TIMEOUT,
  );
});
