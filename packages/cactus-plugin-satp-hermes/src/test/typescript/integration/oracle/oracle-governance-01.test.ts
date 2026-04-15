import "jest-extended";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";

import {
  pruneDockerContainersIfGithubAction,
  Containers,
} from "@hyperledger/cactus-test-tooling";
import { Knex, knex } from "knex";

import {
  SATPGatewayConfig,
  SATPGateway,
  PluginFactorySATPGateway,
  OracleExecuteRequestTaskTypeEnum,
  OracleTaskStatusEnum,
  OracleOperationStatusEnum,
  OracleOperationTypeEnum,
  OracleApi,
  Configuration,
  OracleTaskModeEnum,
} from "../../../../main/typescript";
import {
  Address,
  GatewayIdentity,
} from "../../../../main/typescript/core/types";
import {
  IPluginFactoryOptions,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import { ClaimFormat } from "../../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import { EthereumTestEnvironment } from "../../environments/ethereum-test-environment";
import { BesuTestEnvironment } from "../../environments/besu-test-environment";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../../main/typescript/core/constants";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { v4 as uuidv4 } from "uuid";
import { keccak256 } from "web3-utils";
import { ApiServer } from "@hyperledger/cactus-cmd-api-server";
import { MonitorService } from "../../../../main/typescript/services/monitoring/monitor";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../environments/ethereum-test-environment";
import { SupportedContractTypes as SupportedBesuContractTypes } from "../../environments/ethereum-test-environment";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import HelloWorldContract from "../../../solidity/generated/HelloWorldContract.sol/HelloWorldContract.json";
import { IOracleListenerBase } from "../../../../main/typescript/cross-chain-mechanisms/oracle/oracle-types";

import { createMigrationSource } from "../../../../main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "../../../../main/typescript/database/knexfile";
import { knexRemoteInstance } from "../../../../main/typescript/database/knexfile-remote";

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Hermes",
});
const monitorService = MonitorService.createOrGetMonitorService({
  enabled: false,
});

let oracleApi: OracleApi;
let besuEnv: BesuTestEnvironment;
let ethereumEnv: EthereumTestEnvironment;
let gateway: SATPGateway;
let besuContractAddress: string;
let ethereumContractAddress: string;
let data_hash: string;
let knexSourceRemoteClient: Knex;
let knexLocalClient: Knex;

const TIMEOUT = 900000; // 15 minutes
beforeAll(async () => {
  pruneDockerContainersIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });

  if (knexLocalClient) {
    await knexLocalClient.destroy();
  }
  if (knexSourceRemoteClient) {
    await knexSourceRemoteClient.destroy();
  }

  const businessLogicContract = "HelloWorldContract";

  try {
    besuEnv = await BesuTestEnvironment.setupTestEnvironment(
      {
        logLevel,
      },
      [
        {
          assetType: SupportedBesuContractTypes.ORACLE,
          contractName: businessLogicContract,
        },
      ],
    );
    log.info("Besu Ledger started successfully");

    ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
      {
        logLevel,
      },
      [
        {
          assetType: SupportedEthereumContractTypes.ORACLE,
          contractName: businessLogicContract,
        },
      ],
    );
  } catch (err) {
    log.error("Error starting ledgers: ", err);
  }

  besuContractAddress = await besuEnv.deployAndSetupOracleContracts(
    ClaimFormat.BUNGEE,
    "HelloWorldContract",
    HelloWorldContract,
  );

  ethereumContractAddress = await ethereumEnv.deployAndSetupOracleContracts(
    ClaimFormat.BUNGEE,
    "HelloWorldContract",
    HelloWorldContract,
  );

  const factoryOptions: IPluginFactoryOptions = {
    pluginImportType: PluginImportType.Local,
  };
  const factory = new PluginFactorySATPGateway(factoryOptions);

  const server1 = createServer();
  await new Promise<void>((resolve) => server1.listen(0, resolve));
  const gatewayServerPort = (server1.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server1.close(() => resolve()));

  const server2 = createServer();
  await new Promise<void>((resolve) => server2.listen(0, resolve));
  const gatewayClientPort = (server2.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server2.close(() => resolve()));

  const gatewayIdentity = {
    id: "mockID",
    name: "CustomGateway",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "mockProofID10",
    address: "http://localhost" as Address,
    gatewayServerPort,
    gatewayClientPort,
    database: { oracle: { enabled: false } },
  } as GatewayIdentity;

  const migrationSource = await createMigrationSource();
  knexLocalClient = knex({
    ...knexLocalInstance.default,
    migrations: {
      migrationSource: migrationSource,
    },
  });
  knexSourceRemoteClient = knex({
    ...knexRemoteInstance.default,
    migrations: {
      migrationSource: migrationSource,
    },
  });

  const oracleLogKnex = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource },
  });
  await oracleLogKnex.migrate.latest();

  await knexSourceRemoteClient.migrate.latest();

  const ethNetworkOptions = ethereumEnv.createEthereumConfig();
  const besuNetworkOptions = besuEnv.createBesuConfig();

  const options: SATPGatewayConfig = {
    instanceId: uuidv4(),
    logLevel: "DEBUG",
    gid: gatewayIdentity,
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    ccConfig: {
      oracleConfig: [ethNetworkOptions, besuNetworkOptions],
    },
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    monitorService: monitorService,
  };
  gateway = await factory.create(options);
  expect(gateway).toBeInstanceOf(SATPGateway);

  const identity = gateway.Identity;
  // default servers
  expect(identity.gatewayServerPort).toBe(gatewayServerPort);
  expect(identity.gatewayClientPort).toBe(gatewayClientPort);
  expect(identity.address).toBe("http://localhost");
  await gateway.startup();

  const apiServer = await gateway.getOrCreateHttpServer();
  expect(apiServer).toBeInstanceOf(ApiServer);

  oracleApi = new OracleApi(
    new Configuration({ basePath: gateway.getAddressOApiAddress() }),
  );
  expect(oracleApi).toBeTruthy();
}, TIMEOUT);

afterAll(async () => {
  await gateway.shutdown();
  await besuEnv.tearDown();
  await ethereumEnv.tearDown();
  await pruneDockerContainersIfGithubAction({ logLevel })
    .then(() => {
      log.info("Pruning throw OK");
    })
    .catch(async () => {
      await Containers.logDiagnostics({ logLevel });
      fail("Pruning didn't throw OK");
    });
}, TIMEOUT);

describe("Oracle executing READ, UPDATE, and READ_AND_UPDATE tasks successfully", () => {
  jest.setTimeout(900000);
  it("should fail when writing to a contract calling a function that does not exist", async () => {
    data_hash = keccak256("Hello World!");

    let response = await oracleApi.executeOracleTask({
      destinationNetworkId: ethereumEnv.network,
      destinationContract: {
        contractName: ethereumEnv.getTestOracleContractName(),
        contractAddress: ethereumContractAddress,
        contractAbi: HelloWorldContract.abi,
        contractBytecode: HelloWorldContract.bytecode.object,
        methodName: "invalidFunction",
        params: [],
      },
      taskType: OracleExecuteRequestTaskTypeEnum.Update,
    });

    expect(response).toBeDefined();
    expect(response?.data.taskID).toBeDefined();
    expect(response?.data.operations?.length).toBe(1);
    expect(response?.data.operations?.[0].status).toBe(
      OracleOperationStatusEnum.Failed,
    );

    response = await oracleApi.getOracleTaskStatus(response?.data.taskID ?? "");

    expect(response).toBeDefined();
    expect(response.data.taskID).toBe(response?.data.taskID);
    expect(response.data.status).toBe(OracleTaskStatusEnum.Inactive);
  });

  it("should read data and write it to another blockchain (EVM to Besu)", async () => {
    const message = "Written Message!";

    const writeResponse = await oracleApi.executeOracleTask({
      destinationNetworkId: ethereumEnv.network,
      destinationContract: {
        contractName: ethereumEnv.getTestOracleContractName(),
        contractAddress: ethereumContractAddress,
        contractAbi: HelloWorldContract.abi,
        contractBytecode: HelloWorldContract.bytecode.object,
        methodName: "setMessage",
        params: [message],
      },
      taskType: OracleExecuteRequestTaskTypeEnum.Update,
    });
    expect(writeResponse.data.operations[0].status).toBe(
      OracleOperationStatusEnum.Success,
    );

    const response = await oracleApi.executeOracleTask({
      sourceNetworkId: ethereumEnv.network,
      sourceContract: {
        contractName: ethereumEnv.getTestOracleContractName(),
        contractAddress: ethereumContractAddress,
        contractAbi: HelloWorldContract.abi,
        contractBytecode: HelloWorldContract.bytecode.object,
        methodName: "getMessage",
        params: [],
      },
      destinationNetworkId: besuEnv.network,
      destinationContract: {
        contractName: besuEnv.getTestOracleContractName(),
        contractAddress: besuContractAddress,
        contractAbi: HelloWorldContract.abi,
        methodName: "setMessage",
        params: ["Hello World!"], // overrides the default. The default is what is returned from the source contract
      },
      taskType: OracleExecuteRequestTaskTypeEnum.ReadAndUpdate,
    });

    expect(response).toBeDefined();
    expect(response.data.taskID).toBeDefined();
    expect(response.data.type).toBe(
      OracleExecuteRequestTaskTypeEnum.ReadAndUpdate,
    );
    expect(response.data.operations.length).toBe(2);
    expect(response.data.operations[0].type).toBe(OracleOperationTypeEnum.Read);
    expect(response.data.operations[1].type).toBe(
      OracleOperationTypeEnum.Update,
    );
    expect(response.data.operations[0].status).toBe(
      OracleOperationStatusEnum.Success,
    );
    expect(response.data.operations[1].status).toBe(
      OracleOperationStatusEnum.Success,
    );

    const response2 = await oracleApi.getOracleTaskStatus(
      response.data.taskID ?? "",
    );

    expect(response2).toBeDefined();
    expect(response2).toBeDefined();
    expect(response2?.data.status).toBe(OracleTaskStatusEnum.Inactive);

    const besuData = await besuEnv.readData(
      "HelloWorldContract",
      besuContractAddress,
      HelloWorldContract.abi,
      "getMessage",
      [],
    );

    expect(besuData.success).toBeTruthy();
    expect(besuData.callOutput).toBe("Hello World!");

    const ethereumData = await ethereumEnv.readData(
      "HelloWorldContract",
      ethereumContractAddress,
      HelloWorldContract.abi,
      "getMessage",
      [],
    );

    expect(ethereumData.success).toBeTruthy();
    expect(ethereumData.callOutput).toBe("Written Message!");

    log.info("Data successfully transferred from Ethereum to Besu");
  });

  it("should create event listener in ETH and write updates to Besu", async () => {
    log.debug(
      "Starting test: should create event listener in ETH and write updates to Besu",
    );
    // 1- Create event listener in Ethereum
    const eventListenerTask = await oracleApi.registerOracleTask({
      sourceNetworkId: ethereumEnv.network,
      sourceContract: {
        contractName: ethereumEnv.getTestOracleContractName(),
        contractAddress: ethereumContractAddress,
        contractAbi: HelloWorldContract.abi,
        contractBytecode: HelloWorldContract.bytecode.object,
        methodName: "getMessage",
        params: [],
      },
      listeningOptions: {
        eventSignature: "MessageUpdated(string,string,uint256)",
        filterParams: ["newMessage"],
      },
      destinationNetworkId: besuEnv.network,
      destinationContract: {
        contractName: besuEnv.getTestOracleContractName(),
        contractAddress: besuContractAddress,
        contractAbi: HelloWorldContract.abi,
        contractBytecode: HelloWorldContract.bytecode.object,
        methodName: "setMessage",
        params: [],
      },
      taskType: OracleExecuteRequestTaskTypeEnum.ReadAndUpdate,
      taskMode: OracleTaskModeEnum.EventListening,
    });

    expect(eventListenerTask.data.taskID).toBeDefined();

    log.debug(
      "Waiting 30 seconds for the event listener to be fully set up before triggering the event...",
    );
    await new Promise((resolve) => setTimeout(resolve, 30000));

    log.debug("Event listener fully set up. Triggering event...");
    // 2- Trigger the event by writing to the contract

    await oracleApi.executeOracleTask({
      destinationNetworkId: ethereumEnv.network,
      destinationContract: {
        contractName: ethereumEnv.getTestOracleContractName(),
        contractAddress: ethereumContractAddress,
        contractAbi: HelloWorldContract.abi,
        contractBytecode: HelloWorldContract.bytecode.object,
        methodName: "setMessage",
        params: ["Written after event listener!"],
      },
      taskType: OracleExecuteRequestTaskTypeEnum.Update,
    });

    log.debug(
      "Sent transaction to trigger event. Waiting 30 seconds for the event to be captured and processed...",
    );
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // 3- Verify the event listener captured the event and wrote the update to Besu
    const besuData = await besuEnv.readData(
      "HelloWorldContract",
      besuContractAddress,
      HelloWorldContract.abi,
      "getMessage",
      [],
    );

    expect(besuData.success).toBeTruthy();
    expect(besuData.callOutput).toBe("Written after event listener!");

    log.info(
      "Event listener successfully captured the event and updated Besu contract",
    );

    // 4- Clean up by unregistering the event listener
    await oracleApi.unregisterOracleTask(eventListenerTask.data.taskID ?? "");
  });

  it("Create event listener tru BLODispatcher", async () => {
    const oracle = gateway
      .BLODispatcherInstance!.getOracleManager()
      .getNetworkOracle(ethereumEnv.network, ClaimFormat.BUNGEE);

    let capturedParams: string[] = [];

    const subscription = await oracle.subscribeContractEvent(
      {
        contractName: ethereumEnv.getTestOracleContractName(),
        contractAbi: HelloWorldContract.abi,
        contractAddress: ethereumContractAddress,
        eventSignature: "MessageUpdated(string,string,uint256)",
      } as IOracleListenerBase,
      (params: string[]) => {
        log.info(`Local callback triggered with params: ${params}`);
        capturedParams = params;
      },
      ["newMessage"],
    );

    expect(subscription).toBeDefined();
    expect(subscription.unsubscribe).toBeDefined();

    // Trigger the event
    await oracleApi.executeOracleTask({
      destinationNetworkId: ethereumEnv.network,
      destinationContract: {
        contractName: ethereumEnv.getTestOracleContractName(),
        contractAddress: ethereumContractAddress,
        contractAbi: HelloWorldContract.abi,
        contractBytecode: HelloWorldContract.bytecode.object,
        methodName: "setMessage",
        params: ["Triggering local callback!"],
      },
      taskType: OracleExecuteRequestTaskTypeEnum.Update,
    });

    await new Promise((resolve) => setTimeout(resolve, 30000));

    expect(capturedParams.length).toBeGreaterThan(0);
    expect(capturedParams[0]).toBe("Triggering local callback!");
    subscription.unsubscribe();
  });
});
