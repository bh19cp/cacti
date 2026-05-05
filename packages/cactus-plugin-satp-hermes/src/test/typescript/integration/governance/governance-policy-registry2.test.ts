import "jest-extended";
import fs from "fs";
import path from "path";
import Web3 from "web3";
import { v4 as uuidV4 } from "uuid";
import { knex, Knex } from "knex";
import {
  LogLevel,
  LogLevelDesc,
  LoggerProvider,
} from "@hyperledger/cactus-common";
import { PluginRegistry } from "@hyperledger/cactus-core";
import {
  Configuration,
  LedgerType,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import {
  EthContractInvocationType,
  Web3SigningCredential,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { EthContractInvocationType as BesuContractInvocationType } from "@hyperledger/cactus-plugin-ledger-connector-besu";
import {
  Address,
  GatewayIdentity,
} from "../../../../main/typescript/core/types";
import {
  AdminApi,
  ClaimFormat,
  GetApproveAddressApi,
  MonitorService,
  PluginFactorySATPGateway,
  SATPGateway,
  SATPGatewayConfig,
  TokenType,
  TransactionApi,
} from "../../../../main/typescript";
import {
  SignatureAlgorithm,
  TokenType as TokenTypeMain,
} from "../../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../../main/typescript/core/constants";
import { createMigrationSource } from "../../../../main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "../../../../main/typescript/database/knexfile";
import { knexRemoteInstance } from "../../../../main/typescript/database/knexfile-remote";
import {
  BesuTestEnvironment,
  EthereumTestEnvironment,
  getTransactRequest,
} from "../../test-utils";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../environments/ethereum-test-environment";
import { SupportedContractTypes as SupportedBesuContractTypes } from "../../environments/besu-test-environment";
import { GovernanceConfig } from "./governance-config/governance-config";
import {
  DeployedAddresses,
  OrganizationInfo,
  deployDao,
  encodeSetParameter,
  getGatewayPublicKey,
  registerGatewayViaGovernance,
  runSuccessfulVoting,
  DEFAULT_GAS,
  DEFAULT_GAS_PRICE,
  POLICY_REGISTRY_CONTRACT_NAME,
} from "./governance-test-utils";
import { GovernanceManager } from "../../../../main/typescript/governance/governance-manager";
import { DEFAULT_RUNTIME_POLICY } from "../../../../main/typescript/governance/governance-policy-config";
import PolicyRegistryContract from "../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import { ethers } from "ethers";

const TIMEOUT = 900000;
const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Policy lockExpirationTime test",
});
const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

const RSA_HASH = BigInt(Web3.utils.keccak256("RSA"));

const NEW_SIGNING_ALGORITHM_HASH = RSA_HASH;
const NEW_LOCK_EXPIRATION_MS = BigInt(1000 * 60 * 10);
const NEW_SIGNATURE_ALGORITHM = SignatureAlgorithm.RSA;
const INITIAL_DAO_LOCK_EXPIRATION = 34n;
const INITIAL_DAO_SIGNATURE_ALGORITHM = SignatureAlgorithm.UNSPECIFIED;

let besuEnv: BesuTestEnvironment;
let ethereumEnv: EthereumTestEnvironment;
let gatewayEth: SATPGateway;
let gatewayBesu: SATPGateway;
let knexLocalClient: Knex;
let knexSourceRemoteClient: Knex;
let knexTargetRemoteClient: Knex;
let web3: InstanceType<typeof Web3>;
let deployedContracts: DeployedAddresses;
let organizations: OrganizationInfo[];
let deployerCredentials: Web3SigningCredential;
let governanceManager: GovernanceManager;

beforeAll(async () => {
  const erc20TokenContract = "SATPContract";
  const erc721TokenContract = "SATPNFTContract";

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
  log.info("Besu Ledger started");
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
  log.info("Ethereum Ledger started");
  await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);

  const ontologiesPath = path.join(__dirname, "../../../ontologies");
  const factory = new PluginFactorySATPGateway({
    pluginImportType: PluginImportType.Local,
  });

  const migrationSource = await createMigrationSource();
  knexLocalClient = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource },
  });
  knexSourceRemoteClient = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource },
  });
  knexTargetRemoteClient = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource },
  });
  await knexSourceRemoteClient.migrate.latest();

  const config: GovernanceConfig = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "governance-config/config.json"),
      "utf-8",
    ),
  );
  const daoResult = await deployDao(ethereumEnv, config);
  deployedContracts = daoResult.addresses;
  organizations = daoResult.organizations;
  deployerCredentials = daoResult.deployerCredentials;

  governanceManager = new GovernanceManager({
    logLevel: LogLevel.DEBUG,
    monitorService,
    oracleConfig: ethereumEnv.createEthereumConfig(),
    policyRegistry: {
      contractAddress: deployedContracts.policyRegistry,
      contractAbi: PolicyRegistryContract.abi,
    },
    gatewayRegistry: {
      contractAddress: deployedContracts.gatewayRegistry,
      contractAbi: GatewayRegistryContract.abi,
    },
  });

  const besuGatewayIdentity: GatewayIdentity = {
    id: "besu-gateway-policy-test",
    name: "besu-gateway-policy-test",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proofId-besu-gateway-policy",
    address: "http://localhost" as Address,
    gatewayOapiPort: 4020,
    gatewayServerPort: 3020,
    gatewayClientPort: 3021,
    connectedDLTs: [
      {
        id: BesuTestEnvironment.BESU_NETWORK_ID,
        ledgerType: LedgerType.Besu2X,
      },
    ],
  };

  const ethGatewayIdentity: GatewayIdentity = {
    id: "eth-gateway-policy-test",
    name: "eth-gateway-policy-test",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proofId-eth-gateway-policy",
    address: "http://localhost" as Address,
    gatewayOapiPort: 4021,
    gatewayServerPort: 3022,
    gatewayClientPort: 3023,
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
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [ethGatewayIdentity],
    ccConfig: {
      oracleConfig: [besuEnv.createBesuConfig()],
      bridgeConfig: [besuEnv.createBesuConfig()],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
    gatewayComplianceVerifier: governanceManager,
    gatewayPolicyManager: governanceManager,
  } as SATPGatewayConfig);

  expect(gatewayBesu).toBeInstanceOf(SATPGateway);
  await gatewayBesu.onPluginInit();

  gatewayEth = await factory.create({
    instanceId: uuidV4(),
    logLevel: "DEBUG",
    gid: ethGatewayIdentity,
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    counterPartyGateways: [besuGatewayIdentity],
    ccConfig: {
      oracleConfig: [ethereumEnv.createEthereumConfig()],
      bridgeConfig: [ethereumEnv.createEthereumConfig()],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService,
    ontologyPath: ontologiesPath,
    gatewayComplianceVerifier: governanceManager,
    gatewayPolicyManager: governanceManager,
  } as SATPGatewayConfig);

  expect(gatewayEth).toBeInstanceOf(SATPGateway);
  await gatewayEth.onPluginInit();

  await gatewayBesu.getOrCreateHttpServer();
  await gatewayEth.getOrCreateHttpServer();

  web3 = (ethereumEnv.connector as any).web3;
}, TIMEOUT);

afterAll(async () => {
  await governanceManager.stop();
  if (besuEnv) await besuEnv.tearDown();
  if (ethereumEnv) await ethereumEnv.tearDown();
  if (knexLocalClient) await knexLocalClient.destroy();
  if (knexSourceRemoteClient) await knexSourceRemoteClient.destroy();
  if (knexTargetRemoteClient) await knexTargetRemoteClient.destroy();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

describe("Policy lockExpirationTime update integration", () => {
  jest.setTimeout(TIMEOUT);

  it("should register both gateways via DAO and start GovernanceManager", async () => {
    // Register Ethereum (SERVER) gateway
    const ethPubKey = getGatewayPublicKey(gatewayEth);
    await registerGatewayViaGovernance({
      ethereumEnv,
      web3,
      gatewayPublicKey: ethPubKey,
      gatewayName: "eth-gateway-policy-test",
      deployedContracts,
      organizations,
      deployerCredentials,
      description: "Register Ethereum gateway for policy test",
    });

    // Register Besu (CLIENT) gateway
    const besuPubKey = getGatewayPublicKey(gatewayBesu);
    await registerGatewayViaGovernance({
      ethereumEnv,
      web3,
      gatewayPublicKey: besuPubKey,
      gatewayName: "besu-gateway-policy-test",
      deployedContracts,
      organizations,
      deployerCredentials,
      description: "Register Besu gateway for policy test",
    });

    // Start GovernanceManager — bootstraps policy and gateway registry,
    // registers event subscriptions
    await governanceManager.start(gatewayEth);
    expect(governanceManager.isStarted()).toBe(true);

    // Both gateways should be in the compliance cache and active
    const ethAddress = ethers.computeAddress(
      ethPubKey.startsWith("0x") ? ethPubKey : "0x" + ethPubKey,
    );
    const besuAddress = ethers.computeAddress(
      besuPubKey.startsWith("0x") ? besuPubKey : "0x" + besuPubKey,
    );

    expect(governanceManager.isGatewayCached(ethAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(ethAddress)).toEqual(0);
    expect(governanceManager.isGatewayCached(besuAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(besuAddress)).toEqual(0);
  });

  it("should start with the lockExpirationTime and signatureAlgorithm from the DAO config", () => {
    const policy = governanceManager.getRuntimePolicy();

    log.info(
      `[POLICY_BEFORE] lockExpirationTime=${policy.lockExpirationTime}ms, signatureAlgorithm=${policy.signatureAlgorithm}`,
    );

    expect(policy.lockExpirationTime).toEqual(INITIAL_DAO_LOCK_EXPIRATION);
    expect(policy.signatureAlgorithm).toEqual(INITIAL_DAO_SIGNATURE_ALGORITHM);
  });

  it("should update lockExpirationTime and signatureAlgorithm via DAO vote", async () => {
    const {
      governor: governorAddress,
      timelock: timelockAddress,
      policyRegistry: policyAddress,
    } = deployedContracts;

    // ── Update lockExpirationTime ──────────────────────────────────────────
    const lockKey = "satp.session.lockExpirationTime";
    const lockCalldata = encodeSetParameter(
      web3,
      lockKey,
      NEW_LOCK_EXPIRATION_MS,
    );

    await runSuccessfulVoting({
      ethereumEnv,
      web3,
      governorAddress,
      timelockAddress,
      targetAddress: policyAddress,
      calldata: lockCalldata,
      description: `Update lockExpirationTime to ${NEW_LOCK_EXPIRATION_MS}`,
      organizations,
      deployerCredentials,
    });

    // verify on-chain
    let onChainResult = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: policyAddress,
        contractJSON: {
          contractName: POLICY_REGISTRY_CONTRACT_NAME,
          abi: PolicyRegistryContract.abi,
          bytecode: PolicyRegistryContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      web3SigningCredential: deployerCredentials,
      methodName: "getValue",
      params: [lockKey],
      gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
    });
    expect(BigInt(onChainResult.callOutput)).toEqual(NEW_LOCK_EXPIRATION_MS);

    const sigKey = "signingAlgorithm";
    const sigCalldata = encodeSetParameter(
      web3,
      sigKey,
      NEW_SIGNING_ALGORITHM_HASH,
    );

    await runSuccessfulVoting({
      ethereumEnv,
      web3,
      governorAddress,
      timelockAddress,
      targetAddress: policyAddress,
      calldata: sigCalldata,
      description: `Update signatureAlgorithm to ${NEW_SIGNATURE_ALGORITHM} (RSA)`,
      organizations,
      deployerCredentials,
    });

    onChainResult = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: policyAddress,
        contractJSON: {
          contractName: POLICY_REGISTRY_CONTRACT_NAME,
          abi: PolicyRegistryContract.abi,
          bytecode: PolicyRegistryContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      web3SigningCredential: deployerCredentials,
      methodName: "getValue",
      params: [sigKey],
      gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
    });
    expect(BigInt(onChainResult.callOutput)).toEqual(
      NEW_SIGNING_ALGORITHM_HASH,
    );

    await waitForPolicyCondition(
      () => {
        const p = governanceManager.getRuntimePolicy();
        return (
          p.lockExpirationTime === NEW_LOCK_EXPIRATION_MS &&
          p.signatureAlgorithm === NEW_SIGNATURE_ALGORITHM
        );
      },
      20_000,
      500,
    );

    const policyAfter = governanceManager.getRuntimePolicy();
    log.info(
      `[POLICY_AFTER] lockExpirationTime=${policyAfter.lockExpirationTime}ms, signatureAlgorithm=${policyAfter.signatureAlgorithm}`,
    );

    expect(policyAfter.lockExpirationTime).toEqual(NEW_LOCK_EXPIRATION_MS);
    expect(policyAfter.signatureAlgorithm).toEqual(NEW_SIGNATURE_ALGORITHM);
  });

  it("should complete a full transfer using the updated lockExpirationTime and signatureAlgorithm", async () => {
    const policy = governanceManager.getRuntimePolicy();
    expect(policy.lockExpirationTime).toEqual(NEW_LOCK_EXPIRATION_MS);

    await ensureBalance(besuEnv, "100");

    const { sessionId } = await runTransfer(
      besuEnv,
      ethereumEnv,
      gatewayBesu,
      gatewayEth,
      "100",
    );

    const adminApi = new AdminApi(
      new Configuration({ basePath: gatewayBesu.getAddressOApiAddress() }),
    );
    const statusRes = await adminApi.getStatus(sessionId);

    log.info(
      "[ADMIN_API_SESSION_STATUS] " + JSON.stringify(statusRes?.data, null, 2),
    );

    expect(statusRes?.data.status).toBe("DONE");
    expect(statusRes?.data.substatus).toBe("COMPLETED");
    expect(statusRes?.data.stage).toBe("SATP_STAGE_3");

    const policyAfterTransfer = governanceManager.getRuntimePolicy();
    expect(policyAfterTransfer.lockExpirationTime).toEqual(
      NEW_LOCK_EXPIRATION_MS,
    );
    expect(policy.signatureAlgorithm).toEqual(NEW_SIGNATURE_ALGORITHM);
    log.info(
      `[POLICY_AFTER_TRANSFER] lockExpirationTime=${policyAfterTransfer.lockExpirationTime}ms and signatureAlgorithm=${policyAfterTransfer.signatureAlgorithm}`,
    );

    await besuEnv.checkBalance(
      besuEnv.getTestFungibleContractName(),
      besuEnv.getTestFungibleContractAddress(),
      besuEnv.getTestFungibleContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    await ethereumEnv.checkBalance(
      ethereumEnv.getTestFungibleContractName(),
      ethereumEnv.getTestFungibleContractAddress(),
      ethereumEnv.getTestFungibleContractAbi(),
      ethereumEnv.getTestOwnerAccount(),
      "100",
      ethereumEnv.getTestOwnerSigningCredential(),
    );
  });

  it("should keep the updated lockExpirationTime and signatureAlgorithm in subsequent transfers", async () => {
    const policy = governanceManager.getRuntimePolicy();
    expect(policy.lockExpirationTime).toEqual(NEW_LOCK_EXPIRATION_MS);
    expect(policy.signatureAlgorithm).toEqual(NEW_SIGNATURE_ALGORITHM);

    await ensureBalance(besuEnv, "50");

    const { sessionId } = await runTransfer(
      besuEnv,
      ethereumEnv,
      gatewayBesu,
      gatewayEth,
      "50",
    );

    const adminApi = new AdminApi(
      new Configuration({ basePath: gatewayBesu.getAddressOApiAddress() }),
    );
    const statusRes = await adminApi.getStatus(sessionId);
    expect(statusRes?.data.status).toBe("DONE");
    expect(statusRes?.data.substatus).toBe("COMPLETED");
  });
});

async function waitForPolicyCondition(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `waitForPolicyCondition: timed out after ${timeoutMs}ms — predicate never became true`,
  );
}

async function ensureBalance(
  env: BesuTestEnvironment,
  amount: string,
): Promise<void> {
  const balResponse = await env.connector.invokeContract({
    contractName: env.getTestFungibleContractName(),
    contractAddress: env.getTestFungibleContractAddress(),
    contractAbi: env.getTestFungibleContractAbi(),
    invocationType: BesuContractInvocationType.Call,
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
      invocationType: BesuContractInvocationType.Send,
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

async function runTransfer(
  sourceEnv: BesuTestEnvironment,
  destEnv: EthereumTestEnvironment,
  sourceGateway: SATPGateway,
  destGateway: SATPGateway,
  amount: string,
): Promise<{ sessionId: string }> {
  const approveApiSource = new GetApproveAddressApi(
    new Configuration({ basePath: sourceGateway.getAddressOApiAddress() }),
  );
  const reqSource = await approveApiSource.getApproveAddress(
    sourceEnv.network,
    TokenType.Fungible,
  );
  if (!reqSource?.data.approveAddress) {
    throw new Error("Source approve address undefined");
  }
  await sourceEnv.giveRoleToBridge(reqSource.data.approveAddress);
  await sourceEnv.approveAssets(
    reqSource.data.approveAddress,
    amount,
    TokenTypeMain.NONSTANDARD_FUNGIBLE,
  );

  const approveApiDest = new GetApproveAddressApi(
    new Configuration({ basePath: destGateway.getAddressOApiAddress() }),
  );
  const reqDest = await approveApiDest.getApproveAddress(
    destEnv.network,
    TokenType.Fungible,
  );
  if (!reqDest?.data.approveAddress) {
    throw new Error("Destination approve address undefined");
  }
  await destEnv.giveRoleToBridge(reqDest.data.approveAddress);

  const satpApi = new TransactionApi(
    new Configuration({ basePath: sourceGateway.getAddressOApiAddress() }),
  );
  const integrations = await satpApi.getIntegrations();
  expect(integrations?.data.integrations.length).toBeGreaterThanOrEqual(1);

  const res = await satpApi.transact(
    getTransactRequest("mockContext", sourceEnv, destEnv, amount, amount),
  );

  log.info("[TRANSACT_RESULT] " + JSON.stringify(res.data, null, 2));
  return { sessionId: res.data.sessionID };
}
