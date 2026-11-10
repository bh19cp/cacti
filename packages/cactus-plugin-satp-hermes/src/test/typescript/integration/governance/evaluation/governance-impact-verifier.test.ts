import "jest-extended";
import fs from "fs";
import path from "path";
import { v4 as uuidV4 } from "uuid";
import { knex, Knex } from "knex";
import {
  LogLevel,
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import { PluginRegistry } from "@hyperledger/cactus-core";
import {
  Configuration,
  LedgerType,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import {
  BesuTestEnvironment,
  EthereumTestEnvironment,
  getTransactRequest,
} from "../../../test-utils";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../../environments/ethereum-test-environment";
import { SupportedContractTypes as SupportedBesuContractTypes } from "../../../environments/besu-test-environment";
import { GovernanceConfig } from "../governance-config/governance-config";
import {
  delegateOrganizationTokens,
  deployDao,
  DeployDaoResult,
} from "../utils/governance-test-utils";
import { bufArray2HexStr } from "../../../../../main/typescript/utils/gateway-utils";
import {
  EthContractInvocationType,
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { TokenType as TokenTypeMain } from "../../../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import {
  Address,
  GatewayIdentity,
  MonitorService,
  PluginFactorySATPGateway,
  SATPGateway,
  SATPGatewayConfig,
  TransactionApi,
  TokenType,
  GetApproveAddressApi,
  AdminApi,
  ClaimFormat,
} from "../../../../../main/typescript";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../../../main/typescript/core/constants";
import { GovernanceManager } from "../../../../../main/typescript/governance/governance-manager";
import { createMigrationSource } from "../../../../../main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "../../../../../main/typescript/database/knexfile";
import { knexRemoteInstance } from "../../../../../main/typescript/database/knexfile-remote";
import PolicyRegistryContract from "../../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { SupportedSigningAlgorithms } from "../../../../../main/typescript/core/types";

const TIMEOUT = 4_000_000;
const ITERATIONS = 20;
const T_CRIT_95_49DF = 2.01;
const TRANSFER_POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "Governance Overhead Transfer Test",
});
const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

const ETH_NETWORK_ID_2 = "EthereumLedgerTestNetwork-2";

let besuEnv: BesuTestEnvironment;
let ethereumEnv: EthereumTestEnvironment;
let realGovernanceManager: GovernanceManager;

let knexLocal: Knex;
let knexRemote: Knex;

let organizationsCredentials: Web3SigningCredentialPrivateKeyHex[];
let ORG_A: { address: string; name: string; privateKey: string };
let ORG_B: { address: string; name: string; privateKey: string };
let ORG_C: { address: string; name: string; privateKey: string };

let gatewayBesu: SATPGateway;
let gatewayEthWithGM: SATPGateway;
let gatewayEthWithoutGM: SATPGateway;

interface RunRecord {
  label: "WITH_GM" | "WITHOUT_GM";
  iteration: number;
  timeMs: number | null;
  error: string | null;
}

const allRuns: RunRecord[] = [];

let withGMTimes: number[] = [];
let withoutGMTimes: number[] = [];

beforeAll(async () => {
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
  await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);

  const migrationSource = await createMigrationSource();
  knexLocal = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource },
  });
  knexRemote = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource },
  });
  await knexRemote.migrate.latest();

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
      { key: "signingAlgorithm", value: "ECDSA" },
      { key: "claimFormat", value: "2" },
    ],
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

  const dao = await deployDao(ethereumEnv, DAO_CONFIG);
  await delegateOrganizationTokens(
    ethereumEnv,
    dao.addresses.token,
    organizationsCredentials,
  );

  realGovernanceManager = new GovernanceManager({
    logLevel: LogLevel.DEBUG,
    monitorService,
    oracleConfig: ethereumEnv.createEthereumConfig(),
    policyRegistry: {
      contractAddress: dao.addresses.policyRegistry,
      contractAbi: PolicyRegistryContract.abi,
    },
    gatewayRegistry: {
      contractAddress: dao.addresses.gatewayRegistry,
      contractAbi: GatewayRegistryContract.abi,
    },
  });

  log.info("ORG A address: %s", ORG_A.address);
  log.info("ORG B address: %s", ORG_B.address);
  log.info("ORG C address: %s", ORG_C.address);

  const besuId: GatewayIdentity = {
    id: "besu-gateway-overhead",
    name: "besu-overhead",
    identificationCredential: {
      signingAlgorithm: SupportedSigningAlgorithms.SECP256K1,
      pubKey: bufArray2HexStr(keypairA.publicKey),
    },
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proof-besu-overhead",
    address: "http://localhost" as Address,
    gatewayOapiPort: 4030,
    gatewayServerPort: 3030,
    gatewayClientPort: 3031,
    connectedDLTs: [
      {
        id: BesuTestEnvironment.BESU_NETWORK_ID,
        ledgerType: LedgerType.Besu2X,
      },
    ],
  };

  const ethId: GatewayIdentity = {
    id: "eth-gateway-overhead",
    name: "eth-overhead",
    identificationCredential: {
      signingAlgorithm: SupportedSigningAlgorithms.SECP256K1,
      pubKey: bufArray2HexStr(keypairB.publicKey),
    },
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proof-eth-overhead",
    address: "http://localhost" as Address,
    gatewayOapiPort: 4031,
    gatewayServerPort: 3032,
    gatewayClientPort: 3033,
    connectedDLTs: [
      {
        id: EthereumTestEnvironment.ETH_NETWORK_ID,
        ledgerType: LedgerType.Ethereum,
      },
    ],
  };

  const ethConfig2 = ethereumEnv.createEthereumConfig();
  const eth2OracleConfig = {
    ...ethConfig2,
    networkIdentification: {
      ...ethConfig2.networkIdentification,
      id: ETH_NETWORK_ID_2,
    },
  };

  const ethGateway2Identity: GatewayIdentity = {
    id: "eth-gateway-bench-2",
    name: "eth-gateway-bench-2",
    identificationCredential: {
      signingAlgorithm: SupportedSigningAlgorithms.SECP256K1,
      pubKey: bufArray2HexStr(keypairC.publicKey),
    },
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
    connectedDLTs: [{ id: ETH_NETWORK_ID_2, ledgerType: LedgerType.Ethereum }],
  };

  gatewayBesu = await factory.create({
    instanceId: uuidV4(),
    logLevel: "DEBUG",
    gid: besuId,
    keyPair: keypairA,
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [ethId, ethGateway2Identity],
    ccConfig: {
      oracleConfig: [besuEnv.createBesuConfig()],
      bridgeConfig: [besuEnv.createBesuConfig()],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
    gatewayComplianceVerifier: realGovernanceManager,
    gatewayPolicyManager: realGovernanceManager,
  } as SATPGatewayConfig);
  await gatewayBesu.onPluginInit();

  gatewayEthWithGM = await factory.create({
    instanceId: uuidV4(),
    logLevel: "DEBUG",
    gid: ethId,
    keyPair: keypairB,
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [besuId, ethGateway2Identity],
    ccConfig: {
      oracleConfig: [ethereumEnv.createEthereumConfig()],
      bridgeConfig: [ethereumEnv.createEthereumConfig()],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
    gatewayComplianceVerifier: realGovernanceManager,
    gatewayPolicyManager: realGovernanceManager,
  } as SATPGatewayConfig);
  await gatewayEthWithGM.onPluginInit();

  gatewayEthWithoutGM = await factory.create({
    instanceId: uuidV4(),
    logLevel: "DEBUG",
    gid: ethGateway2Identity,
    keyPair: keypairC,
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [besuId],
    ccConfig: {
      oracleConfig: [eth2OracleConfig],
      bridgeConfig: [eth2OracleConfig],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
  } as SATPGatewayConfig);
  await gatewayEthWithoutGM.onPluginInit();

  await gatewayBesu.getOrCreateHttpServer();
  await gatewayEthWithGM.getOrCreateHttpServer();
  await gatewayEthWithoutGM.getOrCreateHttpServer();

  await realGovernanceManager.start(gatewayEthWithGM);
}, TIMEOUT);

afterAll(async () => {
  _saveResults();

  if (besuEnv) await besuEnv.tearDown();
  if (ethereumEnv) await ethereumEnv.tearDown();
  if (knexLocal) await knexLocal.destroy();
  if (knexRemote) await knexRemote.destroy();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

async function ensureBalance(
  env: BesuTestEnvironment,
  amount: string,
): Promise<void> {
  const balResponse = await env.connector.invokeContract({
    contractName: env.getTestFungibleContractName(),
    contractAddress: env.getTestFungibleContractAddress(),
    contractAbi: env.getTestFungibleContractAbi(),
    invocationType: EthContractInvocationType.Call,
    methodName: "balanceOf",
    params: [env.getTestOwnerAccount()],
    signingCredential: env.getTestOwnerSigningCredential(),
    gas: 1000000,
  });
  expect(balResponse.success).toBeTruthy();
  const currentBalance: string = balResponse.callOutput;

  if (Number(currentBalance) > 0) {
    const burnRes = await env.connector.invokeContract({
      contractName: env.getTestFungibleContractName(),
      contractAddress: env.getTestFungibleContractAddress(),
      contractAbi: env.getTestFungibleContractAbi(),
      invocationType: EthContractInvocationType.Send,
      methodName: "burn",
      params: [env.getTestOwnerAccount(), currentBalance],
      signingCredential: env.getTestOwnerSigningCredential(),
      gas: 1000000,
    });
    expect(burnRes.success).toBeTruthy();
  }

  await env.mintTokens(amount, TokenTypeMain.NONSTANDARD_FUNGIBLE);
  await env.checkBalance(
    env.getTestFungibleContractName(),
    env.getTestFungibleContractAddress(),
    env.getTestFungibleContractAbi(),
    env.getTestOwnerAccount(),
    amount,
    env.getTestOwnerSigningCredential(),
  );
}

async function runTransfer(destGateway: SATPGateway): Promise<number | null> {
  try {
    await ensureBalance(besuEnv, "50");

    const sourceApprove = new GetApproveAddressApi(
      new Configuration({ basePath: gatewayBesu.getAddressOApiAddress() }),
    );
    const srcReq = await sourceApprove.getApproveAddress(
      besuEnv.network,
      TokenType.Fungible,
    );
    const srcApproveAddr = srcReq.data.approveAddress!;
    await besuEnv.giveRoleToBridge(srcApproveAddr);
    await besuEnv.approveAssets(
      srcApproveAddr,
      "50",
      TokenTypeMain.NONSTANDARD_FUNGIBLE,
    );

    const destApprove = new GetApproveAddressApi(
      new Configuration({ basePath: destGateway.getAddressOApiAddress() }),
    );
    const destReq = await destApprove.getApproveAddress(
      destGateway.Identity.id === gatewayEthWithGM.Identity.id
        ? ethereumEnv.network
        : { id: ETH_NETWORK_ID_2, ledgerType: LedgerType.Ethereum },
      TokenType.Fungible,
    );
    const destApproveAddr = destReq.data.approveAddress!;
    await ethereumEnv.giveRoleToBridge(destApproveAddr);

    const satpApi = new TransactionApi(
      new Configuration({ basePath: gatewayBesu.getAddressOApiAddress() }),
    );

    const t0 = Date.now();
    log.info("START transfer at %s", new Date(t0).toISOString());

    const res = await satpApi.transact(
      getTransactRequest("overhead-test", besuEnv, ethereumEnv, "50", "50"),
    );
    const sessionId = res.data.sessionID;

    const pollDeadline = Date.now() + TRANSFER_POLL_TIMEOUT_MS;
    const adminApi = new AdminApi(
      new Configuration({ basePath: gatewayBesu.getAddressOApiAddress() }),
    );

    let status;
    do {
      if (Date.now() > pollDeadline) {
        throw new Error(
          `Transfer ${sessionId} did not reach DONE within ${TRANSFER_POLL_TIMEOUT_MS} ms`,
        );
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      status = (await adminApi.getStatus(sessionId)).data;
    } while (status.status !== "DONE");

    const elapsed = Date.now() - t0;
    log.info("Transfer DONE in %d ms (session %s)", elapsed, sessionId);
    return elapsed;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log.error("Transfer FAILED: %s", msg);
    return null;
  }
}

async function runTransferMultiple(
  destGateway: SATPGateway,
  iterations: number,
  label: "WITH_GM" | "WITHOUT_GM",
): Promise<number[]> {
  const successTimes: number[] = [];
  let failures = 0;

  for (let i = 1; i <= iterations; i++) {
    log.info("─── [%s] run %d / %d ───", label, i, iterations);

    const t = await runTransfer(destGateway);

    const record: RunRecord = {
      label,
      iteration: i,
      timeMs: t,
      error: t === null ? "transfer failed or timed out" : null,
    };
    allRuns.push(record);

    if (t !== null) {
      successTimes.push(t);
      log.info("[%s] run %d/%d ✓  %d ms", label, i, iterations, t);
    } else {
      failures++;
      log.warn(
        "[%s] run %d/%d ✗  (skipped — see error above)",
        label,
        i,
        iterations,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  log.info(
    "[%s] completed — %d successes, %d failures out of %d",
    label,
    successTimes.length,
    failures,
    iterations,
  );
  return successTimes;
}

const CSV_HEADER = "label,iteration,timeMs,error";

function toCsvRow(r: RunRecord): string {
  const safeError = r.error ? `"${r.error.replace(/"/g, '""')}"` : "";
  return `${r.label},${r.iteration},${r.timeMs ?? ""},${safeError}`;
}

function _saveResults(): void {
  try {
    const outputDir = path.join(__dirname, "evaluation-results");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // CSV — one row per run
    const csvPath = path.join(
      outputDir,
      `governance-overhead-${timestamp}.csv`,
    );
    const csvBody = allRuns.map(toCsvRow).join("\n");
    fs.writeFileSync(csvPath, `${CSV_HEADER}\n${csvBody}\n`);
    log.info("CSV saved → %s", csvPath);
  } catch (err) {
    log.error("Failed to save CSV: %s", err);
  }
}

describe("Transfer latency with and without GovernanceManager", () => {
  it(
    "should measure transfer latency with real GovernanceManager (50 iterations)",
    async () => {
      log.info("Running %d transfers WITH GovernanceManager...", ITERATIONS);
      withGMTimes = await runTransferMultiple(
        gatewayEthWithGM,
        ITERATIONS,
        "WITH_GM",
      );
      expect(withGMTimes.length).toBeGreaterThanOrEqual(
        Math.floor(ITERATIONS * 0.8),
      );
    },
    TIMEOUT,
  );

  it(
    "should measure transfer latency without GovernanceManager (50 iterations)",
    async () => {
      log.info("Running %d transfers WITHOUT GovernanceManager...", ITERATIONS);
      withoutGMTimes = await runTransferMultiple(
        gatewayEthWithoutGM,
        ITERATIONS,
        "WITHOUT_GM",
      );
      expect(withoutGMTimes.length).toBeGreaterThanOrEqual(
        Math.floor(ITERATIONS * 0.8),
      );
    },
    TIMEOUT,
  );

  it(
    "should compute statistics and print overhead summary with confidence intervals",
    () => {
      const withN = withGMTimes.length;
      const withoutN = withoutGMTimes.length;

      if (withN < 2 || withoutN < 2) {
        log.warn(
          "Insufficient data for statistics (withGM=%d, withoutGM=%d). Skipping.",
          withN,
          withoutN,
        );
        return;
      }

      if (withN < ITERATIONS || withoutN < ITERATIONS) {
        log.warn(
          "Partial data: withGM=%d/%d, withoutGM=%d/%d. Stats computed on available runs.",
          withN,
          ITERATIONS,
          withoutN,
          ITERATIONS,
        );
      }

      function computeStats(arr: number[]) {
        const n = arr.length;
        const mean = arr.reduce((a, b) => a + b, 0) / n;
        const variance =
          arr.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
        const stddev = Math.sqrt(variance);
        const stderr = stddev / Math.sqrt(n);
        const margin = T_CRIT_95_49DF * stderr;
        return {
          mean,
          stddev,
          stderr,
          ciLower: mean - margin,
          ciUpper: mean + margin,
          n,
        };
      }

      const withStats = computeStats(withGMTimes);
      const withoutStats = computeStats(withoutGMTimes);
      const overheadMean = withStats.mean - withoutStats.mean;
      const overheadPct = (overheadMean / withoutStats.mean) * 100;
      const varSum =
        withStats.stddev ** 2 / withN + withoutStats.stddev ** 2 / withoutN;
      const diffMargin = T_CRIT_95_49DF * Math.sqrt(varSum);

      const summary = {
        timestamp: new Date().toISOString(),
        benchmark: "governance-overhead-transfer",
        requestedIterations: ITERATIONS,
        confidenceIntervalLevel: "95%",
        withGovernanceManager: { timesMs: withGMTimes, stats: withStats },
        withoutGovernanceManager: {
          timesMs: withoutGMTimes,
          stats: withoutStats,
        },
        overhead: {
          absoluteMs: overheadMean,
          percentage: overheadPct.toFixed(2),
          confidenceIntervalMs: {
            lower: overheadMean - diffMargin,
            upper: overheadMean + diffMargin,
          },
        },
        failedRuns: {
          withGM: ITERATIONS - withN,
          withoutGM: ITERATIONS - withoutN,
        },
      };

      log.info("══════ GOVERNANCE OVERHEAD SUMMARY ══════");
      log.info(JSON.stringify(summary, null, 2));

      const outputDir = path.join(__dirname, "evaluation-results");
      if (!fs.existsSync(outputDir))
        fs.mkdirSync(outputDir, { recursive: true });
      const jsonPath = path.join(
        outputDir,
        `governance-overhead-${Date.now()}.json`,
      );
      fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");
      log.info("JSON saved → %s", jsonPath);
    },
    TIMEOUT,
  );
});
