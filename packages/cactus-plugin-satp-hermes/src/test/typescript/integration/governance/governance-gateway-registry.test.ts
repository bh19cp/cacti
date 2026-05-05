import "jest-extended";
import fs from "fs";
import path from "path";
import Web3 from "web3";
import { v4 as uuidV4 } from "uuid";
import { jest } from "@jest/globals";
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
import { TokenType as TokenTypeMain } from "../../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
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
import { EthContractInvocationType as BesuContractInvocationType } from "@hyperledger/cactus-plugin-ledger-connector-besu";
import { GovernanceConfig } from "./governance-config/governance-config";
import {
  DeployedAddresses,
  OrganizationInfo,
  deployDao,
  getGatewayPublicKey,
  registerGatewayViaGovernance,
  runSuccessfulVoting,
} from "./governance-test-utils";
import { GovernanceManager } from "../../../../main/typescript/governance/governance-manager";
import PolicyRegistryContract from "../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import { ethers } from "ethers";
import { GatewayStatus } from "../../../../main/typescript/governance/governance-types";

const TIMEOUT = 900000;
const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Hermes",
});
const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

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
    id: "besu-gateway",
    name: "besu-gateway",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proofId-besu-gateway",
    address: "http://localhost" as Address,
    gatewayOapiPort: 4010,
    gatewayServerPort: 3010,
    gatewayClientPort: 3011,
    connectedDLTs: [
      {
        id: BesuTestEnvironment.BESU_NETWORK_ID,
        ledgerType: LedgerType.Besu2X,
      },
    ],
  };

  const ethGatewayIdentity: GatewayIdentity = {
    id: "eth-gateway",
    name: "eth-gateway",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "proofId-eth-gateway",
    address: "http://localhost" as Address,
    gatewayOapiPort: 4011,
    gatewayServerPort: 3012,
    gatewayClientPort: 3013,
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
  } as SATPGatewayConfig);

  expect(gatewayEth).toBeInstanceOf(SATPGateway);
  await gatewayEth.onPluginInit();

  await gatewayBesu.getOrCreateHttpServer();
  await gatewayEth.getOrCreateHttpServer();

  web3 = (ethereumEnv.connector as any).web3;
}, TIMEOUT);

afterAll(async () => {
  if (besuEnv) await besuEnv.tearDown();
  if (ethereumEnv) await ethereumEnv.tearDown();
  if (knexLocalClient) await knexLocalClient.destroy();
  if (knexSourceRemoteClient) await knexSourceRemoteClient.destroy();
  if (knexTargetRemoteClient) await knexTargetRemoteClient.destroy();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

describe("Gateway Registry integration", () => {
  jest.setTimeout(TIMEOUT);

  it("should register the Ethereum (SERVER) gateway via DAO, start GovernanceManager, and cache it", async () => {
    const gatewayPublicKey = getGatewayPublicKey(gatewayEth);
    const gatewayAddress = ethers.computeAddress(
      gatewayPublicKey.startsWith("0x")
        ? gatewayPublicKey
        : "0x" + gatewayPublicKey,
    );

    await registerGatewayViaGovernance({
      ethereumEnv,
      web3,
      gatewayPublicKey,
      gatewayName: "ethereum-gateway",
      deployedContracts,
      organizations,
      deployerCredentials,
      description: "Register Ethereum gateway for bootstrap test",
    });

    await governanceManager.start(gatewayEth);
    expect(governanceManager.isGatewayCached(gatewayAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(gatewayAddress)).toEqual(0);
  });
  it("should fail transfer when CLIENT gateway is NOT registered in DAO", async () => {
    await ensureBalance(besuEnv, "100");

    /**
     * A GatewayNotCompliantError is thrown, mapping to error code 13.
     * The error is caught and transformed into a FailedToProcessError,
     * which the API endpoint returns as an HTTP 500 error.
     */
    await expect(
      runTransfer(besuEnv, ethereumEnv, gatewayBesu, gatewayEth, "100"),
    ).rejects.toThrow();
  });

  it("should register besu gateway (CLIENT) via governance", async () => {
    const gatewayPublicKey = getGatewayPublicKey(gatewayBesu);
    log.debug("Register Besu Gateway via Governance...");
    await registerGatewayViaGovernance({
      ethereumEnv,
      web3,
      gatewayPublicKey,
      gatewayName: "gateway-name",
      deployedContracts,
      organizations,
      deployerCredentials,
      description: "Register SATP gateway for test",
    });

    const gatewayAddress = ethers.computeAddress(
      gatewayPublicKey.startsWith("0x")
        ? gatewayPublicKey
        : "0x" + gatewayPublicKey,
    );

    const isActive = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: deployedContracts.gatewayRegistry,
        contractJSON: {
          contractName: "GATEWAY_REGISTRY_CONTRACT",
          abi: GatewayRegistryContract.abi,
          bytecode: GatewayRegistryContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      methodName: "isGatewayActive",
      params: [gatewayAddress],
    });
    log.debug("is Active call output: ", isActive.callOutput);
    expect(isActive.callOutput).toBe(true);

    expect(governanceManager.isGatewayCached(gatewayAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(gatewayAddress)).toEqual(0);
  });

  it("should pass stage-0 given that (CLIENT) Besu gateway is registered in DAO", async () => {
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

    await besuEnv.checkBalance(
      besuEnv.getTestFungibleContractName(),
      besuEnv.getTestFungibleContractAddress(),
      besuEnv.getTestFungibleContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    const reqBesu = (
      await new GetApproveAddressApi(
        new Configuration({
          basePath: gatewayBesu.getAddressOApiAddress(),
        }),
      ).getApproveAddress(besuEnv.network, TokenType.Fungible)
    ).data.approveAddress;
    await besuEnv.checkBalance(
      besuEnv.getTestFungibleContractName(),
      besuEnv.getTestFungibleContractAddress(),
      besuEnv.getTestFungibleContractAbi(),
      reqBesu,
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    const reqEth = (
      await new GetApproveAddressApi(
        new Configuration({
          basePath: gatewayEth.getAddressOApiAddress(),
        }),
      ).getApproveAddress(ethereumEnv.network, TokenType.Fungible)
    ).data.approveAddress;
    await ethereumEnv.checkBalance(
      ethereumEnv.getTestFungibleContractName(),
      ethereumEnv.getTestFungibleContractAddress(),
      ethereumEnv.getTestFungibleContractAbi(),
      reqEth,
      "0",
      ethereumEnv.getTestOwnerSigningCredential(),
    );
    await ethereumEnv.checkBalance(
      ethereumEnv.getTestFungibleContractName(),
      ethereumEnv.getTestFungibleContractAddress(),
      ethereumEnv.getTestFungibleContractAbi(),
      ethereumEnv.getTestOwnerAccount(),
      "100",
      ethereumEnv.getTestOwnerSigningCredential(),
    );

    const auditRes = await adminApi.performAudit(0, Date.now());
    expect(auditRes?.data.sessions).toBeDefined();
  });

  it("should have exactly two gateways cached after both DAO registrations", () => {
    const ethGatewayPublicKey = getGatewayPublicKey(gatewayEth);
    const ethAddress = ethers.computeAddress(
      ethGatewayPublicKey.startsWith("0x")
        ? ethGatewayPublicKey
        : "0x" + ethGatewayPublicKey,
    );
    const besuGatewayPublicKey = getGatewayPublicKey(gatewayBesu);
    const besuAddress = ethers.computeAddress(
      besuGatewayPublicKey.startsWith("0x")
        ? besuGatewayPublicKey
        : "0x" + besuGatewayPublicKey,
    );

    expect(governanceManager.isGatewayCached(ethAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(ethAddress)).toEqual(0);
    expect(governanceManager.isGatewayCached(besuAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(besuAddress)).toEqual(0);

    expect(
      governanceManager.isGatewayCached(
        "0x0000000000000000000000000000000000000000",
      ),
    ).toBe(false);
  });

  it("should remove besu gateway via DAO vote and then reject a new transfer", async () => {
    const besuGatewayPublicKey = getGatewayPublicKey(gatewayBesu);
    const besuGatewayAddress = ethers.computeAddress(
      besuGatewayPublicKey.startsWith("0x")
        ? besuGatewayPublicKey
        : "0x" + besuGatewayPublicKey,
    );

    const beforeRemove = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: deployedContracts.gatewayRegistry,
        contractJSON: {
          contractName: "GatewayRegistry",
          abi: GatewayRegistryContract.abi,
          bytecode: GatewayRegistryContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      methodName: "isGatewayActive",
      params: [besuGatewayAddress],
    });
    expect(beforeRemove.callOutput).toBe(true);

    const removeCalldata = encodeGatewayRegistryCall("removeGateway", [
      besuGatewayAddress,
      "Removed via DAO vote – integration test",
    ]);

    await runSuccessfulVoting({
      ethereumEnv,
      web3,
      governorAddress: deployedContracts.governor,
      timelockAddress: deployedContracts.timelock,
      targetAddress: deployedContracts.gatewayRegistry,
      calldata: removeCalldata,
      description: "Remove besu gateway from GatewayRegistry",
      organizations,
      deployerCredentials,
    });

    const afterRemove = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: deployedContracts.gatewayRegistry,
        contractJSON: {
          contractName: "GatewayRegistry",
          abi: GatewayRegistryContract.abi,
          bytecode: GatewayRegistryContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      methodName: "isGatewayActive",
      params: [besuGatewayAddress],
    });
    expect(afterRemove.callOutput).toBe(false);
    await waitForCacheCondition(
      () =>
        !governanceManager.isGatewayCached(besuGatewayAddress) ||
        governanceManager.getCachedGatewayStatus(besuGatewayAddress) !== 0,
      15_000,
      500,
    );

    log.info(
      `[CACHE] besu cached=${governanceManager.isGatewayCached(besuGatewayAddress)} ` +
        `status=${governanceManager.getCachedGatewayStatus(besuGatewayAddress)}`,
    );

    await ensureBalance(besuEnv, "100");

    await expect(
      runTransfer(besuEnv, ethereumEnv, gatewayBesu, gatewayEth, "100"),
    ).rejects.toThrow();
  });

  it("should update the cache when eth gateway status is changed to Suspended via DAO vote", async () => {
    const ethGatewayPublicKey = getGatewayPublicKey(gatewayEth);
    const ethGatewayAddress = ethers.computeAddress(
      ethGatewayPublicKey.startsWith("0x")
        ? ethGatewayPublicKey
        : "0x" + ethGatewayPublicKey,
    );

    expect(governanceManager.isGatewayCached(ethGatewayAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(ethGatewayAddress)).toEqual(
      GatewayStatus.Active,
    );

    const beforeChange = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: deployedContracts.gatewayRegistry,
        contractJSON: {
          contractName: "GatewayRegistry",
          abi: GatewayRegistryContract.abi,
          bytecode: GatewayRegistryContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      methodName: "isGatewayActive",
      params: [ethGatewayAddress],
    });
    expect(beforeChange.callOutput).toBe(true);
    const setStatusCalldata = encodeGatewayRegistryCall("setGatewayStatus", [
      ethGatewayAddress,
      GatewayStatus.Suspended,
      "Suspended via DAO vote – integration test",
    ]);

    await runSuccessfulVoting({
      ethereumEnv,
      web3,
      governorAddress: deployedContracts.governor,
      timelockAddress: deployedContracts.timelock,
      targetAddress: deployedContracts.gatewayRegistry,
      calldata: setStatusCalldata,
      description: "Suspend eth gateway in GatewayRegistry",
      organizations,
      deployerCredentials,
    });

    const afterChange = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: deployedContracts.gatewayRegistry,
        contractJSON: {
          contractName: "GatewayRegistry",
          abi: GatewayRegistryContract.abi,
          bytecode: GatewayRegistryContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      methodName: "isGatewayActive",
      params: [ethGatewayAddress],
    });
    expect(afterChange.callOutput).toBe(false);
    await waitForCacheCondition(
      () =>
        governanceManager.getCachedGatewayStatus(ethGatewayAddress) ===
        GatewayStatus.Suspended,
      15_000,
      500,
    );

    log.info(
      `[CACHE] eth cached=${governanceManager.isGatewayCached(ethGatewayAddress)} ` +
        `status=${governanceManager.getCachedGatewayStatus(ethGatewayAddress)}`,
    );

    expect(governanceManager.isGatewayCached(ethGatewayAddress)).toBe(true);
    expect(governanceManager.getCachedGatewayStatus(ethGatewayAddress)).toEqual(
      GatewayStatus.Suspended,
    );
    const isCompliant =
      await governanceManager.isGatewayCompliant(ethGatewayPublicKey);
    expect(isCompliant).toBe(false);
  });
});

async function waitForCacheCondition(
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
    `waitForCacheCondition: timed out after ${timeoutMs} ms – predicate never became true`,
  );
}

function encodeGatewayRegistryCall(
  methodName: string,
  params: unknown[],
): string {
  const abiItem = GatewayRegistryContract.abi.find(
    (item: any) => item.type === "function" && item.name === methodName,
  );
  if (!abiItem) {
    throw new Error(
      `encodeGatewayRegistryCall: "${methodName}" not found in ABI`,
    );
  }
  return web3.eth.abi.encodeFunctionCall(abiItem as any, params as any);
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
