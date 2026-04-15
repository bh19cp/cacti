import "jest-extended";
import express from "express";
import bodyParser from "body-parser";
import { createServer } from "node:http";
import http from "http";
import {
  Address,
  GatewayIdentity,
} from "../../../../main/typescript/core/types";
import { AddressInfo } from "node:net";
import { v4 as uuidV4 } from "uuid";
import { Server as SocketIoServer } from "socket.io";
import Web3 from "web3";

import {
  IListenOptions,
  Servers,
  LoggerProvider,
  LogLevel,
} from "@hyperledger/cactus-common";
import fs from "fs";
import { PluginRegistry } from "@hyperledger/cactus-core";
import {
  Configuration,
  Constants,
  IPluginFactoryOptions,
  LedgerType,
  PluginImportType,
} from "@hyperledger/cactus-core-api";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { GethTestLedger } from "@hyperledger/cactus-test-geth-ledger";
import TokenContract from "../../../solidity/generated/Token.sol/Token.json";
import TimelockContract from "../../../solidity/generated/Timelock.sol/Timelock.json";
import GatewayRegistryContract from "../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import PolicyRegistryContract from "../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GovernanceWithTimelockContract from "../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";
import {
  EthContractInvocationType,
  DefaultApi as EthereumApi,
  PluginLedgerConnectorEthereum,
  Web3SigningCredential,
  Web3SigningCredentialType,
  Web3TransactionReceipt,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { GovernanceConfig } from "./governance-config/governance-config";
import {
  ClaimFormat,
  MonitorService,
  OracleApi,
  PluginFactorySATPGateway,
  SATPGateway,
  SATPGatewayConfig,
} from "../../../../main/typescript";
import { Knex, knex } from "knex";
import { createMigrationSource } from "../../../../main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "../../../../main/typescript/database/knexfile";
import { knexRemoteInstance } from "../../../../main/typescript/database/knexfile-remote";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../../main/typescript/core/constants";
import { IOracleListenerBase } from "../../../../main/typescript/cross-chain-mechanisms/oracle/oracle-types";
import { GovernanceManager } from "../../../../main/typescript/governance/governance-manager";
import { ParameterUpdatedHandler } from "../../../../main/typescript/governance/handlers/ParameterUpdatedHandler";

const TOKEN_CONTRACT_NAME = "TokenContract";
const TIMELOCK_CONTRACT_NAME = "TimelockContract";
const GATEWAY_REGISTRY_CONTRACT_NAME = "GatewayRegistryContract";
const POLICY_REGISTRY_CONTRACT_NAME = "PolicyRegistryContract";
const GOVERNANCE_TIMELOCK_CONTRACT_NAME = "GovernanceWithTimelockContract";
const containerImageName = "ghcr.io/hyperledger/cacti-geth-all-in-one";
const containerImageVersion = "2023-07-27-2a8c48ed6";
const DEFAULT_GAS = "6721975";
const DEFAULT_GAS_PRICE = "20000000000"; // 20 gwei

interface DeployedAddresses {
  token: string;
  timelock: string;
  gatewayRegistry: string;
  policyRegistry: string;
  governor: string;
}

interface OrganizationInfo {
  address: string;
  credential: Web3SigningCredential;
}

const loglevel = LogLevel.DEBUG;
const log = LoggerProvider.getOrCreate({
  level: loglevel,
  label: "SATP - Hermes",
});

describe("Ethereum contract deploy and invoke using keychain tests", () => {
  let gateway: SATPGateway;
  let oracleApi: OracleApi;
  let knexLocalClient: Knex;
  let knexSourceRemoteClient: Knex;
  const monitorService = MonitorService.createOrGetMonitorService({
    enabled: false,
  });
  let deployedContracts: DeployedAddresses;
  let organizations: OrganizationInfo[];
  let deployerCredentials: Web3SigningCredential = {} as Web3SigningCredential;
  let web3: InstanceType<typeof Web3>,
    addressInfo,
    address: string,
    port: number,
    apiHost,
    apiConfig,
    ledger: GethTestLedger,
    apiClient: EthereumApi,
    connector: PluginLedgerConnectorEthereum,
    rpcApiHttpHost: string,
    rpcApiWsHost: string,
    keychainPlugin: PluginKeychainMemory;
  const expressApp = express();
  expressApp.use(bodyParser.json({ limit: "250mb" }));
  const server = http.createServer(expressApp);
  const wsApi = new SocketIoServer(server, {
    path: Constants.SocketIoConnectionPathV1,
  });

  function encodeSetParameter(key: string, value: bigint): string {
    const methodAbi = PolicyRegistryContract.abi.find(
      (m: any) => m.name === "setParameter" && m.type === "function",
    );
    if (!methodAbi) {
      throw new Error("setParameter function not found in ABI");
    }
    return web3.eth.abi.encodeFunctionCall(methodAbi as any, [
      key,
      value.toString(),
    ]);
  }

  function extractProposalId(
    receipt: Web3TransactionReceipt,
    governorAddress: string,
  ): string {
    if (!receipt.logs) {
      throw new Error("Receipt has no logs");
    }

    const eventAbi = {
      anonymous: false,
      name: "ProposalCreated",
      type: "event",
      inputs: [
        { indexed: false, name: "proposalId", type: "uint256" },
        { indexed: false, name: "proposer", type: "address" },
        { indexed: false, name: "targets", type: "address[]" },
        { indexed: false, name: "values", type: "uint256[]" },
        { indexed: false, name: "signatures", type: "string[]" },
        { indexed: false, name: "calldatas", type: "bytes[]" },
        { indexed: false, name: "voteStart", type: "uint256" },
        { indexed: false, name: "voteEnd", type: "uint256" },
        { indexed: false, name: "description", type: "string" },
      ],
    };

    const eventSig = web3.eth.abi.encodeEventSignature(eventAbi as any);

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === governorAddress.toLowerCase() &&
        log.topics[0] === eventSig
      ) {
        const decoded: any = web3.eth.abi.decodeLog(
          eventAbi.inputs,
          log.data,
          [],
        );
        return decoded.proposalId.toString();
      }
    }

    throw new Error("ProposalCreated event not found");
  }

  async function advanceBlocks(n: number): Promise<void> {
    const fromAddress = (deployerCredentials as any).ethAccount;
    const privateKey = (deployerCredentials as any).secret;
    for (let i = 0; i < n; i++) {
      const nonce = await web3.eth.getTransactionCount(fromAddress);
      const tx = {
        from: fromAddress,
        to: fromAddress,
        value: "0x0",
        gas: 21000,
        gasPrice: DEFAULT_GAS_PRICE,
        nonce: nonce,
      };
      const signed = await web3.eth.accounts.signTransaction(tx, privateKey);
      await web3.eth.sendSignedTransaction(signed.rawTransaction);
    }
    log.info(`Advanced ${n} blocks via self-transfers`);
  }

  //////////////////////////////////
  // Setup
  //////////////////////////////////

  beforeAll(async () => {
    const pruning = pruneDockerContainersIfGithubAction({
      logLevel: loglevel,
    });
    await expect(pruning).resolves.toBeTruthy();

    ledger = new GethTestLedger({
      containerImageName,
      containerImageVersion,
    });
    await ledger.start();

    const listenOptions: IListenOptions = {
      hostname: "127.0.0.1",
      port: 0,
      server,
    };
    addressInfo = (await Servers.listen(listenOptions)) as AddressInfo;
    ({ address, port } = addressInfo);
    apiHost = `http://${address}:${port}`;
    apiConfig = new Configuration({ basePath: apiHost });
    apiClient = new EthereumApi(apiConfig);
    rpcApiHttpHost = await ledger.getRpcApiHttpHost();
    rpcApiWsHost = await ledger.getRpcApiWebSocketHost();
    web3 = new Web3(rpcApiHttpHost);
    keychainPlugin = new PluginKeychainMemory({
      instanceId: uuidV4(),
      keychainId: uuidV4(),
      backend: new Map([
        [TOKEN_CONTRACT_NAME, JSON.stringify(TokenContract)],
        [TIMELOCK_CONTRACT_NAME, JSON.stringify(TimelockContract)],
        [
          GATEWAY_REGISTRY_CONTRACT_NAME,
          JSON.stringify(GatewayRegistryContract),
        ],
        [POLICY_REGISTRY_CONTRACT_NAME, JSON.stringify(PolicyRegistryContract)],
        [
          GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          JSON.stringify(GovernanceWithTimelockContract),
        ],
      ]),
      logLevel: loglevel,
    });
    connector = new PluginLedgerConnectorEthereum({
      instanceId: uuidV4(),
      rpcApiWsHost,
      logLevel: loglevel,
      pluginRegistry: new PluginRegistry({ plugins: [keychainPlugin] }),
    });

    await connector.getOrCreateWebServices();
    await connector.registerWebServices(expressApp, wsApi);

    // DAO

    const config: GovernanceConfig = JSON.parse(
      fs.readFileSync(
        "/home/rui-comba/Desktop/cactus-plugin-ichaingov/cacti/packages/cactus-plugin-satp-hermes/src/test/typescript/integration/oracle/governance-config/config.json",
        "utf-8",
      ),
    );
    const result = await DeployDao(config);
    deployedContracts = result.addresses;
    organizations = result.organizations;

    // SATP Gateway Setup
    const migrationSource = await createMigrationSource();
    knexLocalClient = knex({
      ...knexLocalInstance.default,
      migrations: { migrationSource },
    });
    knexSourceRemoteClient = knex({
      ...knexRemoteInstance.default,
      migrations: { migrationSource },
    });
    await knexLocalClient.migrate.latest();
    await knexSourceRemoteClient.migrate.latest();

    const server1 = createServer();
    await new Promise<void>((resolve) => server1.listen(0, resolve));
    const gatewayServerPort = (server1.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server1.close(() => resolve()));

    const server2 = createServer();
    await new Promise<void>((resolve) => server2.listen(0, resolve));
    const gatewayClientPort = (server2.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server2.close(() => resolve()));

    const gatewayIdentity: GatewayIdentity = {
      id: uuidV4(),
      name: "TestGateway",
      version: [
        {
          Core: SATP_CORE_VERSION,
          Architecture: SATP_ARCHITECTURE_VERSION,
          Crash: SATP_CRASH_VERSION,
        },
      ],
      proofID: "mockProofID",
      address: `http://${address}:${port}` as Address,
      gatewayServerPort,
      gatewayClientPort,
    };

    const ethNetworkConfig = {
      networkIdentification: {
        id: "geth-testnet",
        ledgerType: LedgerType.Ethereum,
      },
      signingCredential: deployerCredentials,
      wrapperContractName: "",
      wrapperContractAddress: "",
      connectorOptions: {
        rpcApiWsHost,
      },
      claimFormats: [ClaimFormat.BUNGEE],
      gasConfig: { gas: DEFAULT_GAS, gasPrice: DEFAULT_GAS_PRICE },
    };

    const factoryOptions: IPluginFactoryOptions = {
      pluginImportType: PluginImportType.Local,
    };
    const factory = new PluginFactorySATPGateway(factoryOptions);
    const gatewayOptions: SATPGatewayConfig = {
      instanceId: uuidV4(),
      logLevel: "DEBUG",
      gid: gatewayIdentity,
      localRepository: knexLocalInstance.default,
      remoteRepository: knexRemoteInstance.default,
      ccConfig: {
        oracleConfig: [ethNetworkConfig],
      },
      pluginRegistry: new PluginRegistry({ plugins: [] }),
      monitorService,
    };
    gateway = await factory.create(gatewayOptions);
    await gateway.startup();

    oracleApi = new OracleApi(
      new Configuration({ basePath: gateway.getAddressOApiAddress() }),
    );
  });

  afterAll(async () => {
    await ledger.stop();
    await ledger.destroy();
    await Servers.shutdown(server);

    const pruning = pruneDockerContainersIfGithubAction({
      logLevel: loglevel,
    });
    await expect(pruning).resolves.toBeTruthy();
  });

  /**
   * TEST THAT USES GOVERNANCE MANAGER
   */

  test.only("Governance manager: Governance proposal to update claimFormat parameter", async () => {
    const governorAddress = deployedContracts.governor;
    const timelockAddress = deployedContracts.timelock;
    const policyAddress = deployedContracts.policyRegistry;

    const getNumber = async (
      contractAddr: string,
      method: string,
      contractJSON: any,
      ...args: any[]
    ): Promise<number> => {
      const contract = new web3.eth.Contract(contractJSON.abi, contractAddr);
      const result = await contract.methods[method](...args).call();
      return Number(result);
    };

    const votingDelay = await getNumber(
      governorAddress,
      "votingDelay",
      GovernanceWithTimelockContract,
    );
    const votingPeriod = await getNumber(
      governorAddress,
      "votingPeriod",
      GovernanceWithTimelockContract,
    );
    const minDelay = await getNumber(
      timelockAddress,
      "getMinDelay",
      TimelockContract,
    );
    log.info(
      `votingDelay=${votingDelay}, votingPeriod=${votingPeriod}, timelockDelay=${minDelay}`,
    );

    const oracle = gateway
      .BLODispatcherInstance!.getOracleManager()
      .getNetworkOracle(
        { id: "geth-testnet", ledgerType: LedgerType.Ethereum },
        ClaimFormat.BUNGEE,
      );

    const governanceManager = new GovernanceManager({
      logLevel: LogLevel.DEBUG,
      monitorService,
      gateway,
      oracle,
      policyRegistry: {
        contractAddress: deployedContracts.policyRegistry,
        contractAbi: PolicyRegistryContract.abi,
      },
      gatewayRegistry: {
        contractAddress: deployedContracts.gatewayRegistry,
        contractAbi: GatewayRegistryContract.abi,
      },
    });

    governanceManager.registerHandler(new ParameterUpdatedHandler(gateway));

    await governanceManager.start();

    const KEY = "claimFormat";
    const NEW_VALUE = 0n;
    const calldata = encodeSetParameter(KEY, NEW_VALUE);
    const description = `Update claimFormat to (${Date.now()})`;
    const descHash = Web3.utils.keccak256(description);

    const proposer = organizations[0];
    const proposeResult = await apiClient.invokeContractV1({
      contract: {
        contractAddress: governorAddress,
        contractJSON: {
          contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          abi: GovernanceWithTimelockContract.abi,
          bytecode: GovernanceWithTimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: proposer.credential,
      methodName: "propose",
      params: [[policyAddress], [0], [calldata], description],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const proposeReceipt = (proposeResult.data as any).out?.transactionReceipt;
    if (!proposeReceipt || !proposeReceipt.status) {
      throw new Error("Propose transaction failed");
    }
    printTxReceipt(proposeReceipt, "Propose Update claimFormat");

    const proposalId = extractProposalId(proposeReceipt, governorAddress);
    log.info(`Proposal ID: ${proposalId}`);

    await advanceBlocks(votingDelay + 1);
    log.debug(
      `Voting delay of ${votingDelay} blocks has passed. Starting voting...`,
    );

    const governorContract = new web3.eth.Contract(
      GovernanceWithTimelockContract.abi,
      governorAddress,
    );
    const state = await governorContract.methods.state(proposalId).call();
    log.info(`Proposal state before voting: ${state}`);

    for (const org of organizations) {
      const voteResult = await apiClient.invokeContractV1({
        contract: {
          contractAddress: governorAddress,
          contractJSON: {
            contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
            abi: GovernanceWithTimelockContract.abi,
            bytecode: GovernanceWithTimelockContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: org.credential,
        methodName: "castVote",
        params: [proposalId, 1],
        gasConfig: {
          gas: DEFAULT_GAS,
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      const voteReceipt = (voteResult.data as any).out?.transactionReceipt;
      if (!voteReceipt || !voteReceipt.status) {
        throw new Error(`Vote from ${org.address} failed`);
      }
      log.debug(`Organization ${org.address} casted YES vote.`);
    }

    await advanceBlocks(votingPeriod + 1);
    log.info(`Voting period ended (${votingPeriod} blocks)`);
    const stateBeforeQueue = await governorContract.methods
      .state(proposalId)
      .call();
    log.info(`Proposal state before queue: ${stateBeforeQueue}`);
    // Expected: 4 = Succeeded. Values: 0=Pending,1=Active,2=Canceled,3=Defeated,4=Succeeded,5=Queued,6=Expired,7=Executed
    const queueResult = await apiClient.invokeContractV1({
      contract: {
        contractAddress: governorAddress,
        contractJSON: {
          contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          abi: GovernanceWithTimelockContract.abi,
          bytecode: GovernanceWithTimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: proposer.credential,
      methodName: "queue",
      params: [[policyAddress], [0], [calldata], descHash],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const queueReceipt = (queueResult.data as any).out?.transactionReceipt;
    if (!queueReceipt || !queueReceipt.status) {
      throw new Error("Queue transaction failed");
    }
    printTxReceipt(queueReceipt, "Queue Proposal");

    if (minDelay > 0) {
      log.info(`Waiting ${minDelay + 1} seconds for timelock delay...`);
      await new Promise((resolve) =>
        setTimeout(resolve, (minDelay + 1) * 1000),
      );
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const executeResult = await apiClient.invokeContractV1({
      contract: {
        contractAddress: governorAddress,
        contractJSON: {
          contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          abi: GovernanceWithTimelockContract.abi,
          bytecode: GovernanceWithTimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: proposer.credential,
      methodName: "execute",
      params: [[policyAddress], [0], [calldata], descHash],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const executeReceipt = (executeResult.data as any).out?.transactionReceipt;
    if (!executeReceipt || !executeReceipt.status) {
      throw new Error("Execute transaction failed");
    }
    printTxReceipt(executeReceipt, "Execute Proposal");

    const policyContract = new web3.eth.Contract(
      PolicyRegistryContract.abi,
      policyAddress,
    );
    const finalValue = await policyContract.methods.getValue(KEY).call();
    expect(Number(finalValue)).toBe(Number(NEW_VALUE));
    log.info(`Parameter ${KEY} updated to ${finalValue}`);
  });

  test("ad-hoc: Governance proposal to update claimFormat parameter", async () => {
    const governorAddress = deployedContracts.governor;
    const timelockAddress = deployedContracts.timelock;
    const policyAddress = deployedContracts.policyRegistry;

    const getNumber = async (
      contractAddr: string,
      method: string,
      contractJSON: any,
      ...args: any[]
    ): Promise<number> => {
      const contract = new web3.eth.Contract(contractJSON.abi, contractAddr);
      const result = await contract.methods[method](...args).call();
      return Number(result);
    };

    const votingDelay = await getNumber(
      governorAddress,
      "votingDelay",
      GovernanceWithTimelockContract,
    );
    const votingPeriod = await getNumber(
      governorAddress,
      "votingPeriod",
      GovernanceWithTimelockContract,
    );
    const minDelay = await getNumber(
      timelockAddress,
      "getMinDelay",
      TimelockContract,
    );
    log.info(
      `votingDelay=${votingDelay}, votingPeriod=${votingPeriod}, timelockDelay=${minDelay}`,
    );

    // setup event listener using gateway
    const oracle = gateway
      .BLODispatcherInstance!.getOracleManager()
      .getNetworkOracle(
        { id: "geth-testnet", ledgerType: LedgerType.Ethereum },
        ClaimFormat.BUNGEE,
      );

    const subscription = await oracle.subscribeContractEvent(
      {
        contractName: POLICY_REGISTRY_CONTRACT_NAME,
        contractAbi: PolicyRegistryContract.abi,
        contractAddress: deployedContracts.policyRegistry,
        eventSignature: "ParameterUpdated(string,uint256,uint256,uint256)",
      } as IOracleListenerBase,
      (params: string[]) => {
        log.info(`Local callback triggered with params: ${params}`);
      },
    );

    const KEY = "claimFormat";
    const NEW_VALUE = 1n;
    const calldata = encodeSetParameter(KEY, NEW_VALUE);
    const description = `Update claimFormat to 1 (${Date.now()})`;
    const descHash = Web3.utils.keccak256(description);

    // 3. Propose (using first organization, orgA)
    const proposer = organizations[0];
    const proposeResult = await apiClient.invokeContractV1({
      contract: {
        contractAddress: governorAddress,
        contractJSON: {
          contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          abi: GovernanceWithTimelockContract.abi,
          bytecode: GovernanceWithTimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: proposer.credential,
      methodName: "propose",
      params: [[policyAddress], [0], [calldata], description],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const proposeReceipt = (proposeResult.data as any).out?.transactionReceipt;
    if (!proposeReceipt || !proposeReceipt.status) {
      throw new Error("Propose transaction failed");
    }
    printTxReceipt(proposeReceipt, "Propose Update claimFormat");

    const proposalId = extractProposalId(proposeReceipt, governorAddress);
    log.info(`Proposal ID: ${proposalId}`);

    await advanceBlocks(votingDelay + 1);
    log.debug(
      `Voting delay of ${votingDelay} blocks has passed. Starting voting...`,
    );

    // Check proposal state (use direct web3 to avoid BigInt serialization)
    const governorContract = new web3.eth.Contract(
      GovernanceWithTimelockContract.abi,
      governorAddress,
    );
    const state = await governorContract.methods.state(proposalId).call();
    log.info(`Proposal state before voting: ${state}`);

    // 5. All three organizations vote YES
    for (const org of organizations) {
      const voteResult = await apiClient.invokeContractV1({
        contract: {
          contractAddress: governorAddress,
          contractJSON: {
            contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
            abi: GovernanceWithTimelockContract.abi,
            bytecode: GovernanceWithTimelockContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: org.credential,
        methodName: "castVote",
        params: [proposalId, 1],
        gasConfig: {
          gas: DEFAULT_GAS,
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      const voteReceipt = (voteResult.data as any).out?.transactionReceipt;
      if (!voteReceipt || !voteReceipt.status) {
        throw new Error(`Vote from ${org.address} failed`);
      }
      log.debug(`Organization ${org.address} casted YES vote.`);
    }

    await advanceBlocks(votingPeriod + 1);
    log.info(`Voting period ended (${votingPeriod} blocks)`);
    const stateBeforeQueue = await governorContract.methods
      .state(proposalId)
      .call();
    log.info(`Proposal state before queue: ${stateBeforeQueue}`);
    // Expected: 4 = Succeeded. Values: 0=Pending,1=Active,2=Canceled,3=Defeated,4=Succeeded,5=Queued,6=Expired,7=Executed
    const queueResult = await apiClient.invokeContractV1({
      contract: {
        contractAddress: governorAddress,
        contractJSON: {
          contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          abi: GovernanceWithTimelockContract.abi,
          bytecode: GovernanceWithTimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: proposer.credential,
      methodName: "queue",
      params: [[policyAddress], [0], [calldata], descHash],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const queueReceipt = (queueResult.data as any).out?.transactionReceipt;
    if (!queueReceipt || !queueReceipt.status) {
      throw new Error("Queue transaction failed");
    }
    printTxReceipt(queueReceipt, "Queue Proposal");

    if (minDelay > 0) {
      log.info(`Waiting ${minDelay + 1} seconds for timelock delay...`);
      await new Promise((resolve) =>
        setTimeout(resolve, (minDelay + 1) * 1000),
      );
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const executeResult = await apiClient.invokeContractV1({
      contract: {
        contractAddress: governorAddress,
        contractJSON: {
          contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          abi: GovernanceWithTimelockContract.abi,
          bytecode: GovernanceWithTimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: proposer.credential,
      methodName: "execute",
      params: [[policyAddress], [0], [calldata], descHash],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const executeReceipt = (executeResult.data as any).out?.transactionReceipt;
    if (!executeReceipt || !executeReceipt.status) {
      throw new Error("Execute transaction failed");
    }
    printTxReceipt(executeReceipt, "Execute Proposal");

    const policyContract = new web3.eth.Contract(
      PolicyRegistryContract.abi,
      policyAddress,
    );
    const finalValue = await policyContract.methods.getValue(KEY).call();
    expect(Number(finalValue)).toBe(Number(NEW_VALUE));
    log.info(`Parameter ${KEY} updated to ${finalValue}`);
  });

  async function DeployDao(config: GovernanceConfig): Promise<{
    addresses: DeployedAddresses;
    organizations: OrganizationInfo[];
  }> {
    const account = ledger.createEthTestAccount();
    deployerCredentials = {
      ethAccount: (await account).address,
      secret: (await account).privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    };

    const tokenAddress = await deployContract(
      TOKEN_CONTRACT_NAME,
      TokenContract.abi,
      TokenContract.bytecode.object,
      deployerCredentials,
      [
        config.tokenomics.name,
        config.tokenomics.symbol,
        config.tokenomics.supply.toString(),
        deployerCredentials.ethAccount,
      ],
    );

    const timelockAddress = await deployContract(
      TIMELOCK_CONTRACT_NAME,
      TimelockContract.abi,
      TimelockContract.bytecode.object,
      deployerCredentials,
      [
        config.timelock.minDelay.toString(),
        [],
        [],
        deployerCredentials.ethAccount,
      ],
    );

    const gatewayRegistryAddress = await deployContract(
      GATEWAY_REGISTRY_CONTRACT_NAME,
      GatewayRegistryContract.abi,
      GatewayRegistryContract.bytecode.object,
      deployerCredentials,
      [deployerCredentials.ethAccount],
    );

    const policyRegistryAddress = await deployContract(
      POLICY_REGISTRY_CONTRACT_NAME,
      PolicyRegistryContract.abi,
      PolicyRegistryContract.bytecode.object,
      deployerCredentials,
      [deployerCredentials.ethAccount],
    );

    const orgInfos = await createOrganizations(
      config,
      deployerCredentials,
      gatewayRegistryAddress,
      tokenAddress,
    );

    await sendRemainingTokensToTreasury(
      config,
      deployerCredentials,
      tokenAddress,
      timelockAddress,
    );

    await addProtocolParametersToPolicyRegistry(
      config.protocolParameters,
      deployerCredentials,
      policyRegistryAddress,
    );

    await transferOwnershipToTimelock(
      deployerCredentials,
      GATEWAY_REGISTRY_CONTRACT_NAME,
      gatewayRegistryAddress,
      timelockAddress,
    );

    await transferOwnershipToTimelock(
      deployerCredentials,
      POLICY_REGISTRY_CONTRACT_NAME,
      policyRegistryAddress,
      timelockAddress,
    );

    const governorAddress = await deployContract(
      GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      GovernanceWithTimelockContract.abi,
      GovernanceWithTimelockContract.bytecode.object,
      deployerCredentials,
      [
        config.name,
        tokenAddress,
        timelockAddress,
        config.governance.votingDelay,
        config.governance.votingPeriod,
        config.governance.proposalThreshold,
        config.governance.quorumFraction,
        mapVotingSystem(config.governance.votingSystem),
        gatewayRegistryAddress,
      ],
    );

    await configureTimelockRoles(
      deployerCredentials,
      timelockAddress,
      governorAddress,
    );

    return {
      addresses: {
        token: tokenAddress,
        timelock: timelockAddress,
        gatewayRegistry: gatewayRegistryAddress,
        policyRegistry: policyRegistryAddress,
        governor: governorAddress,
      },
      organizations: orgInfos,
    };
  }

  async function deployContract(
    contractName: string,
    abi: any[],
    bytecode: string,
    credential: Web3SigningCredential,
    constructorArgs: any[] = [],
  ): Promise<string> {
    const response = await apiClient.deployContract({
      contract: {
        contractJSON: {
          contractName,
          abi,
          bytecode,
        },
      },
      web3SigningCredential: credential,
      constructorArgs,
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const receipt = response.data.transactionReceipt;
    if (!receipt?.contractAddress) {
      throw new Error(
        `Deployment of ${contractName} failed: no contract address`,
      );
    }

    printTxReceipt(receipt, contractName);

    return receipt.contractAddress;
  }

  function printTxReceipt(
    receipt: Web3TransactionReceipt,
    label = "Transaction Receipt",
  ): void {
    console.log(`\n=== ${label} ===`);
    console.log(`Status           : ${receipt.status ? "true" : "FAILED"}`);
    console.log(`Tx Hash          : ${receipt.transactionHash}`);
    console.log(`Block Number     : ${receipt.blockNumber}`);
    console.log(`Block Hash       : ${receipt.blockHash}`);
    console.log(`Tx Index         : ${receipt.transactionIndex}`);
    console.log(`From             : ${receipt.from}`);
    console.log(`To               : ${receipt.to ?? "Contract Creation"}`);
    console.log(`Gas Used         : ${receipt.gasUsed}`);

    if (receipt.contractAddress) {
      console.log(`Contract Address : ${receipt.contractAddress}`);
    }

    console.log(`===========================\n`);
  }

  async function createOrganizations(
    config: GovernanceConfig,
    deployerCredential: Web3SigningCredential,
    gatewayRegistryAddress: string = "",
    tokenContractAddress: string = "",
  ): Promise<OrganizationInfo[]> {
    const orgInfos: OrganizationInfo[] = [];
    log.info("Creating 3 organizations...");

    for (let i = 0; i < 3; i++) {
      const orgAccount = await ledger.createEthTestAccount();
      const orgAddress = orgAccount.address;
      const orgCredential: Web3SigningCredential = {
        ethAccount: orgAddress,
        secret: orgAccount.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      };
      orgInfos.push({ address: orgAddress, credential: orgCredential });
      log.info(`Org${String.fromCharCode(65 + i)} address: ${orgAddress}`);

      const transfer = await apiClient.invokeContractV1({
        contract: {
          contractAddress: tokenContractAddress,
          contractJSON: {
            contractName: TOKEN_CONTRACT_NAME,
            abi: TokenContract.abi,
            bytecode: TokenContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: deployerCredential,
        methodName: "transfer",
        params: [orgAddress, config.tokenomics.defaultMemberTokens.toString()],
        gasConfig: {
          gas: DEFAULT_GAS,
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      if ((transfer.data as any).out?.transactionReceipt) {
        printTxReceipt(
          (transfer.data as any).out?.transactionReceipt,
          `Transfer to ${orgAddress}: `,
        );
      } else
        throw new Error(
          `Transfer to ${orgAddress} failed: no transaction receipt`,
        );

      const delegate = await apiClient.invokeContractV1({
        contract: {
          contractAddress: tokenContractAddress,
          contractJSON: {
            contractName: TOKEN_CONTRACT_NAME,
            abi: TokenContract.abi,
            bytecode: TokenContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: orgCredential,
        methodName: "delegate",
        params: [orgAddress],
        gasConfig: {
          gas: DEFAULT_GAS,
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      if ((delegate.data as any).out?.transactionReceipt) {
        printTxReceipt(
          (delegate.data as any).out?.transactionReceipt,
          `Delegate voting power for ${orgAddress}`,
        );
      } else throw new Error(`Delegate for ${orgAddress} failed`);

      const tokenContract = new web3.eth.Contract(
        TokenContract.abi,
        tokenContractAddress,
      );
      const balance = await tokenContract.methods.balanceOf(orgAddress).call();
      log.info(`Balance of ${orgAddress}: ${balance?.toString()}`);

      const registerOrg = await apiClient.invokeContractV1({
        contract: {
          contractAddress: gatewayRegistryAddress,
          contractJSON: {
            contractName: GATEWAY_REGISTRY_CONTRACT_NAME,
            abi: GatewayRegistryContract.abi,
            bytecode: GatewayRegistryContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: deployerCredential,
        methodName: "registerOrganization",
        params: [orgAddress, "Org" + String.fromCharCode(65 + i), 1000],
        gasConfig: {
          gas: DEFAULT_GAS,
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      if ((registerOrg.data as any).out?.transactionReceipt) {
        printTxReceipt(
          (registerOrg.data as any).out?.transactionReceipt,
          `Register Org${String.fromCharCode(65 + i)} in Gateway Registry`,
        );
      } else throw new Error(`Register organization ${orgAddress} failed`);
    }

    return orgInfos;
  }
  async function sendRemainingTokensToTreasury(
    config: GovernanceConfig,
    deployerCredential: Web3SigningCredential,
    tokenContractAddress: string,
    timelockAddress: string,
  ): Promise<void> {
    const deployerAddress = (deployerCredential as any).ethAccount as string;
    const tokenContract = new web3.eth.Contract(
      TokenContract.abi,
      tokenContractAddress,
    );
    const balance = await tokenContract.methods
      .balanceOf(deployerAddress)
      .call();
    const remaining = balance?.toString();
    log.info(`Deployer remaining token balance: ${remaining}`);

    if (remaining && remaining !== "0") {
      // Transfer remaining tokens to timelock (treasury)
      const transferToTreasury = await apiClient.invokeContractV1({
        contract: {
          contractAddress: tokenContractAddress,
          contractJSON: {
            contractName: TOKEN_CONTRACT_NAME,
            abi: TokenContract.abi,
            bytecode: TokenContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: deployerCredential,
        methodName: "transfer",
        params: [timelockAddress, remaining],
        gasConfig: {
          gas: DEFAULT_GAS,
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      const receipt = (transferToTreasury.data as any).out?.transactionReceipt;
      if (receipt) {
        printTxReceipt(
          receipt,
          `Transfer Remaining Tokens to Timelock (Treasury)`,
        );
      } else {
        throw new Error("Transfer to treasury failed: no receipt");
      }

      const timelockBalance = await tokenContract.methods
        .balanceOf(timelockAddress)
        .call();
      log.info(
        `Timelock token balance after transfer: ${timelockBalance?.toString()}`,
      );
    } else {
      log.info("No remaining tokens to transfer to treasury.");
    }
  }

  /**
   * Parses a string value into a BigInt suitable for the contract.
   * - "true"  → 1
   * - "false" → 0
   * - numeric string → BigInt(number)
   * - other string → BigInt(keccak256 hash)
   */
  function parseParameterValue(value: string): bigint {
    if (value === "true") return 1n;
    if (value === "false") return 0n;
    if (!isNaN(Number(value))) return BigInt(value);

    const hash = Web3.utils.keccak256(value);
    return BigInt(hash);
  }

  async function addProtocolParametersToPolicyRegistry(
    protocolParameters: GovernanceConfig["protocolParameters"],
    deployerCredential: Web3SigningCredential,
    policyRegistryAddress: string,
  ): Promise<void> {
    if (!protocolParameters || protocolParameters.length === 0) {
      log.info("No protocol parameters to add.");
      return;
    }

    log.info(
      `Adding ${protocolParameters.length} protocol parameters to PolicyRegistry...`,
    );

    for (const param of protocolParameters) {
      const parsedValue = parseParameterValue(param.value);
      log.info(
        `Adding parameter: ${param.key} = ${param.value} (parsed: ${parsedValue})`,
      );

      const addParamResult = await apiClient.invokeContractV1({
        contract: {
          contractAddress: policyRegistryAddress,
          contractJSON: {
            contractName: POLICY_REGISTRY_CONTRACT_NAME,
            abi: PolicyRegistryContract.abi,
            bytecode: PolicyRegistryContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: deployerCredential,
        methodName: "addParameter",
        params: [param.key, parsedValue.toString()],
        gasConfig: {
          gas: DEFAULT_GAS,
          gasPrice: DEFAULT_GAS_PRICE,
        },
      });

      const receipt = (addParamResult.data as any).out?.transactionReceipt;
      if (!receipt || !receipt.status) {
        throw new Error(`Failed to add parameter ${param.key}`);
      }
      printTxReceipt(receipt, `Add Parameter: ${param.key}`);
    }

    log.info("All protocol parameters added successfully.");
  }

  async function transferOwnershipToTimelock(
    deployerCredential: Web3SigningCredential,
    contractName: string,
    contractAddress: string,
    timelockAddress: string,
  ): Promise<void> {
    log.info(`Transferring ownership of ${contractName} to Timelock...`);
    const contractJsonStr = await keychainPlugin.get(contractName);
    if (!contractJsonStr) {
      throw new Error(`Contract ${contractName} not found in keychain`);
    }
    const contractJson = JSON.parse(contractJsonStr);

    const result = await apiClient.invokeContractV1({
      contract: {
        contractAddress,
        contractJSON: {
          contractName,
          abi: contractJson.abi,
          bytecode: contractJson.bytecode.object || contractJson.bytecode,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: deployerCredential,
      methodName: "transferOwnership",
      params: [timelockAddress],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const receipt = (result.data as any).out?.transactionReceipt;
    if (!receipt || !receipt.status) {
      throw new Error(`Transfer ownership of ${contractName} failed`);
    }
    printTxReceipt(
      receipt,
      `Transfer Ownership of ${contractName} to Timelock`,
    );
  }
  // Helper: map voting system string to enum number
  function mapVotingSystem(system: string): number {
    switch (system) {
      case "quadratic":
        return 1;
      case "weighted-reputation":
        return 2;
      case "token-based":
      default:
        return 0;
    }
  }

  async function configureTimelockRoles(
    deployerCredential: Web3SigningCredential,
    timelockAddress: string,
    governorAddress: string,
  ): Promise<void> {
    log.info("Fetching Timelock role identifiers...");

    const timelockContract = new web3.eth.Contract(
      TimelockContract.abi,
      timelockAddress,
    );

    const PROPOSER_ROLE = (await timelockContract.methods
      .PROPOSER_ROLE()
      .call()) as string;
    const EXECUTOR_ROLE = (await timelockContract.methods
      .EXECUTOR_ROLE()
      .call()) as string;
    const CANCELLER_ROLE = (await timelockContract.methods
      .CANCELLER_ROLE()
      .call()) as string;
    const ADMIN_ROLE = (await timelockContract.methods
      .DEFAULT_ADMIN_ROLE()
      .call()) as string;

    log.info(`PROPOSER_ROLE: ${PROPOSER_ROLE}`);
    log.info(`EXECUTOR_ROLE: ${EXECUTOR_ROLE}`);
    log.info(`CANCELLER_ROLE: ${CANCELLER_ROLE}`);
    log.info(`DEFAULT_ADMIN_ROLE: ${ADMIN_ROLE}`);

    const changeRole = async (
      method: "grantRole" | "revokeRole",
      role: string,
      account: string,
    ) => {
      log.info(`${method} ${role} to ${account}`);
      const result = await apiClient.invokeContractV1({
        contract: {
          contractAddress: timelockAddress,
          contractJSON: {
            contractName: TIMELOCK_CONTRACT_NAME,
            abi: TimelockContract.abi,
            bytecode: TimelockContract.bytecode.object,
          },
        },
        invocationType: EthContractInvocationType.Send,
        web3SigningCredential: deployerCredential,
        methodName: method,
        params: [role, account],
        gasConfig: { gas: DEFAULT_GAS, gasPrice: DEFAULT_GAS_PRICE },
      });

      const receipt = (result.data as any).out?.transactionReceipt;
      if (!receipt || !receipt.status) {
        throw new Error(`${method} ${role} to ${account} failed`);
      }
      printTxReceipt(receipt, `${method} ${role} to ${account}`);
    };

    const deployerAddress = (deployerCredential as any).ethAccount as string;
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    await changeRole("grantRole", PROPOSER_ROLE, governorAddress);
    await changeRole("grantRole", CANCELLER_ROLE, governorAddress);
    await changeRole("grantRole", EXECUTOR_ROLE, ZERO_ADDRESS); // allow anyone to execute
    await changeRole("revokeRole", ADMIN_ROLE, deployerAddress);

    log.info("Timelock roles configured successfully.");
  }
  const changeRole = async (
    method: "grantRole" | "revokeRole",
    role: string,
    account: string,
  ) => {
    log.info(`${method} ${role} to ${account}`);
    const result = await apiClient.invokeContractV1({
      contract: {
        contractAddress: deployedContracts.timelock,
        contractJSON: {
          contractName: TIMELOCK_CONTRACT_NAME,
          abi: TimelockContract.abi,
          bytecode: TimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: deployerCredentials,
      methodName: method,
      params: [role, account],
      gasConfig: {
        gas: DEFAULT_GAS,
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    const receipt = (result.data as any).out?.transactionReceipt;
    if (!receipt || !receipt.status) {
      throw new Error(`${method} ${role} to ${account} failed`);
    }
    printTxReceipt(receipt, `${method} ${role} to ${account}`);
  };
});
