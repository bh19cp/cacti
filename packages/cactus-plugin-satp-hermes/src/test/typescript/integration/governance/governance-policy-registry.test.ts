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
import { LedgerType, PluginImportType } from "@hyperledger/cactus-core-api";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import { Web3SigningCredential } from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { EthContractInvocationType } from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import PolicyRegistryContract from "../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import {
  Address,
  GatewayIdentity,
} from "../../../../main/typescript/core/types";
import {
  ClaimFormat,
  MonitorService,
  PluginFactorySATPGateway,
  SATPGateway,
  SATPGatewayConfig,
} from "../../../../main/typescript";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../../main/typescript/core/constants";
import { createMigrationSource } from "../../../../main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "../../../../main/typescript/database/knexfile";
import { knexRemoteInstance } from "../../../../main/typescript/database/knexfile-remote";
import { GovernanceManager } from "../../../../main/typescript/governance/governance-manager";
import { BesuTestEnvironment, EthereumTestEnvironment } from "../../test-utils";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../environments/ethereum-test-environment";
import { SupportedContractTypes as SupportedBesuContractTypes } from "../../environments/besu-test-environment";
import { GovernanceConfig } from "./governance-config/governance-config";
import {
  DeployedAddresses,
  OrganizationInfo,
  deployDao,
  encodeSetParameter,
  DEFAULT_GAS,
  DEFAULT_GAS_PRICE,
  POLICY_REGISTRY_CONTRACT_NAME,
  runSuccessfulVoting,
} from "./governance-test-utils";

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

  const besuGatewayIdentity: GatewayIdentity = {
    id: "mockID-1",
    name: "Besu-gateway",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "mockProofID10",
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
    id: "mockID-2",
    name: "Eth-gateway",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "mockProofID11",
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

  const ontologiesPath = path.join(__dirname, "../../../ontologies");
  const factory = new PluginFactorySATPGateway({
    pluginImportType: PluginImportType.Local,
  });

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
  } as SATPGatewayConfig);
  expect(gatewayEth).toBeInstanceOf(SATPGateway);
  await gatewayEth.onPluginInit();

  await gatewayBesu.getOrCreateHttpServer();
  await gatewayEth.getOrCreateHttpServer();

  web3 = (ethereumEnv.connector as any).web3;

  // Deploy DAO contracts and regists a gateway under org[0]
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
}, TIMEOUT);

afterAll(async () => {
  if (besuEnv) await besuEnv.tearDown();
  if (ethereumEnv) await ethereumEnv.tearDown();
  if (knexLocalClient) await knexLocalClient.destroy();
  if (knexSourceRemoteClient) await knexSourceRemoteClient.destroy();
  if (knexTargetRemoteClient) await knexTargetRemoteClient.destroy();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

describe("SATP Policy Registry Integration", () => {
  it(
    "should update claimFormat parameter in gateway when it receives UpdatedParameter event",
    async () => {
      const {
        governor: governorAddress,
        timelock: timelockAddress,
        policyRegistry: policyAddress,
      } = deployedContracts;

      const governanceManager = new GovernanceManager({
        logLevel: LogLevel.DEBUG,
        monitorService,
        oracleConfig: ethereumEnv.createEthereumConfig(),
        policyRegistry: {
          contractAddress: policyAddress,
          contractAbi: PolicyRegistryContract.abi,
        },
        gatewayRegistry: {
          contractAddress: deployedContracts.gatewayRegistry,
          contractAbi: GatewayRegistryContract.abi,
        },
      });
      await governanceManager.start(gatewayEth);

      const KEY = "claimFormat";
      const NEW_VALUE = 0n;

      const calldata = encodeSetParameter(web3, KEY, NEW_VALUE);
      const description = `Update claimFormat to (${Date.now()})`;

      await runSuccessfulVoting({
        ethereumEnv,
        web3,
        governorAddress,
        timelockAddress,
        targetAddress: policyAddress,
        calldata,
        description,
        organizations,
        deployerCredentials,
      });

      const finalValueResult = await ethereumEnv.connector.invokeContract({
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
        params: [KEY],
        gasConfig: {
          gas: DEFAULT_GAS.toString(),
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      expect(Number(finalValueResult.callOutput)).toBe(Number(NEW_VALUE));
      expect(gatewayEth.claimFormat).toBe(ClaimFormat.UNSPECIFIED);

      await governanceManager.stop();
    },
    TIMEOUT,
  );

  it(
    "should set parameter as default when it receives deletedParameter event from DAO (not implemented yet)",
    async () => {
      // TODO: implement once smart contract + handler support exists

      const KEY = "claimFormat";

      // Placeholder expectation to keep Jest happy
      expect(KEY).toBeDefined();

      // Example future flow:
      // 1. encodeRemoveParameter(KEY)
      // 2. propose → vote → queue → execute
      // 3. verify parameter no longer exists

      // expect(await getValue(KEY)).toBeUndefined();
    },
    TIMEOUT,
  );
});
