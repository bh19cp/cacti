import "jest-extended";
import { v4 as uuidv4 } from "uuid";
import express from "express";
import bodyParser from "body-parser";
import http from "http";
import { Server as SocketIoServer } from "socket.io";

import {
  PluginFactoryLedgerConnector,
  PluginLedgerConnectorBesu,
  Web3SigningCredentialType,
  Web3SigningCredential,
  DefaultApi as BesuApi,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";

import { PluginRegistry } from "@hyperledger/cactus-core";
import { PluginImportType, Constants } from "@hyperledger/cactus-core-api";
import {
  BesuTestLedger,
  pruneDockerContainersIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import {
  LogLevelDesc,
  LoggerProvider,
  Servers,
  IListenOptions,
} from "@hyperledger/cactus-common";

import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { Configuration } from "../../../../main/typescript/public-api";
import { GovernanceConfig } from "./governance-config/governance-config";
import fs from "fs";
import { Web3TransactionReceipt } from "@hyperledger/cactus-plugin-ledger-connector-besu";
import TokenContract from "../../../solidity/generated/Token.sol/Token.json";
import TimelockContract from "../../../solidity/generated/Timelock.sol/Timelock.json";
import GatewayRegistryContract from "../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import PolicyRegistryContract from "../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GovernanceWithTimelockContract from "../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";
import { EthContractInvocationType } from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import Web3 from "web3";

const TOKEN_CONTRACT_NAME = "TokenContract";
const TIMELOCK_CONTRACT_NAME = "TimelockContract";
const GATEWAY_REGISTRY_CONTRACT_NAME = "GatewayRegistryContract";
const POLICY_REGISTRY_CONTRACT_NAME = "PolicyRegistryContract";
const GOVERNANCE_TIMELOCK_CONTRACT_NAME = "GovernanceWithTimelockContract";

const log = LoggerProvider.getOrCreate({
  level: "DEBUG",
  label: "SATP - Hermes",
});

enum VotingSystem {
  TokenBased,
  Quadratic,
  WeightedReputation,
}

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

describe("SATP Hermes Token deployment", () => {
  const logLevel: LogLevelDesc = "INFO";
  const estimatedGas = 6721975;
  const connectorInstanceId = uuidv4();
  const pluginRegistry = new PluginRegistry({});

  let deployerCredentials: Web3SigningCredential;
  const keychainId = uuidv4();
  const keychainPlugin = new PluginKeychainMemory({
    instanceId: uuidv4(),
    keychainId,
    backend: new Map([
      [TOKEN_CONTRACT_NAME, JSON.stringify(TokenContract)],
      [TIMELOCK_CONTRACT_NAME, JSON.stringify(TimelockContract)],
      [GATEWAY_REGISTRY_CONTRACT_NAME, JSON.stringify(GatewayRegistryContract)],
      [POLICY_REGISTRY_CONTRACT_NAME, JSON.stringify(PolicyRegistryContract)],
      [
        GOVERNANCE_TIMELOCK_CONTRACT_NAME,
        JSON.stringify(GovernanceWithTimelockContract),
      ],
    ]),
    logLevel,
  });

  const expressApp = express();
  expressApp.use(bodyParser.json({ limit: "250mb" }));
  const server = http.createServer(expressApp);
  const wsApi = new SocketIoServer(server, {
    path: Constants.SocketIoConnectionPathV1,
  });

  const listenOptions: IListenOptions = {
    hostname: "127.0.0.1",
    port: 0,
    server,
  };

  let besuTestLedger: BesuTestLedger;
  let connector: PluginLedgerConnectorBesu;
  let besuApi: BesuApi;

  let deployedContracts: DeployedAddresses;
  let organizations: OrganizationInfo[];

  beforeAll(async () => {
    besuTestLedger = new BesuTestLedger();
    await besuTestLedger.start();

    const rpcApiHttpHost = await besuTestLedger.getRpcApiHttpHost();
    const rpcApiWsHost = await besuTestLedger.getRpcApiWsHost();

    const factory = new PluginFactoryLedgerConnector({
      pluginImportType: PluginImportType.Local,
    });

    connector = await factory.create({
      instanceId: connectorInstanceId,
      rpcApiHttpHost,
      rpcApiWsHost,
      logLevel,
      pluginRegistry: new PluginRegistry({ plugins: [keychainPlugin] }),
    });

    pluginRegistry.add(connector);

    await connector.getOrCreateWebServices();
    await connector.registerWebServices(expressApp, wsApi);

    const { address, port } = await Servers.listen(listenOptions);
    const apiHost = `http://${address}:${port}`;

    const configuration = new Configuration({ basePath: apiHost });
    besuApi = new BesuApi(configuration);

    const config: GovernanceConfig = JSON.parse(
      fs.readFileSync(
        "/home/rui-comba/Desktop/cactus-plugin-ichaingov/cacti/packages/cactus-plugin-satp-hermes/src/test/typescript/integration/oracle/governance-config/config.json",
        "utf-8",
      ),
    );

    const result = await DeployDao(config);
    deployedContracts = result.addresses;
    organizations = result.organizations;
  });

  afterAll(async () => {
    await besuTestLedger.stop();
    await besuTestLedger.destroy();
    await Servers.shutdown(server);
    await expect(
      pruneDockerContainersIfGithubAction({ logLevel }),
    ).resolves.not.toThrow();
  });

  test("Governance proposal to update claimFormat parameter", async () => {
    // 1. Read governance parameters from contracts
    const governorAddress = deployedContracts.governor;
    const timelockAddress = deployedContracts.timelock;
    const policyAddress = deployedContracts.policyRegistry;

    const getNumber = async (
      contractAddr: string,
      method: string,
      contractName: string,
      ...args: any[]
    ) => {
      const result = await besuApi.invokeContractV1({
        contractName: contractName,
        contractAddress: contractAddr,
        invocationType: EthContractInvocationType.Call,
        methodName: method,
        params: args,
        signingCredential: organizations[0].credential,
      });
      return Number(result.data.callOutput);
    };

    const votingDelay = await getNumber(
      governorAddress,
      "votingDelay",
      GOVERNANCE_TIMELOCK_CONTRACT_NAME,
    );
    const votingPeriod = await getNumber(
      governorAddress,
      "votingPeriod",
      GOVERNANCE_TIMELOCK_CONTRACT_NAME,
    );
    const minDelay = await getNumber(
      timelockAddress,
      "getMinDelay",
      TIMELOCK_CONTRACT_NAME,
    );
    log.info(
      `votingDelay=${votingDelay}, votingPeriod=${votingPeriod}, timelockDelay=${minDelay}`,
    );

    // 2. Prepare proposal
    const KEY = "claimFormat";
    const NEW_VALUE = 1n;
    const calldata = encodeSetParameter(KEY, NEW_VALUE);
    const description = `Update claimFormat to 1 (${Date.now()})`;
    const descHash = Web3.utils.keccak256(description);

    // set event listener

    // 3. Propose (using first organization, orgA)
    const proposer = organizations[0];
    const proposeResult = await connector.invokeContract({
      contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      contractAddress: governorAddress,
      contractAbi: GovernanceWithTimelockContract.abi,
      signingCredential: proposer.credential,
      invocationType: EthContractInvocationType.Send,
      methodName: "propose",
      params: [[policyAddress], [0], [calldata], description],
      gas: estimatedGas,
    });
    expect(proposeResult.success).toBe(true);
    console.log(
      "ORG A proposed a change to claimFormat parameter to 1.Receipt from propose transaction:",
    );
    const receipt = (proposeResult as any).out
      .transactionReceipt as Web3TransactionReceipt;
    console.log(receipt);

    const proposalId = extractProposalId(receipt, governorAddress);
    log.info(`Proposal ID: ${proposalId}`);

    await advanceBlocks(votingDelay + 1);

    log.debug(
      `Voting delay of ${votingDelay} blocks has passed. Starting voting...`,
    );

    const stateResult = await connector.invokeContract({
      contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      contractAddress: governorAddress,
      contractAbi: GovernanceWithTimelockContract.abi,
      signingCredential: proposer.credential,
      invocationType: EthContractInvocationType.Call,
      methodName: "state",
      params: [proposalId],
    });
    const state = Number(stateResult.callOutput);
    log.info(`Proposal state before voting: ${state}`); // 0=Pending, 1=Active, 2=Canceled, 3=Defeated, 4=Succeeded, 5=Queued, 6=Expired, 7=Executed

    // 5. All three organizations vote YES
    for (const org of organizations) {
      const voteResult = await connector.invokeContract({
        contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
        contractAddress: governorAddress,
        contractAbi: GovernanceWithTimelockContract.abi,
        signingCredential: org.credential,
        invocationType: EthContractInvocationType.Send,
        methodName: "castVote",
        params: [proposalId, 1], // 1 = For
        gas: estimatedGas,
      });
      log.debug(
        `Organization ${org.address} casted YES vote. Tx receipt:`,
        (voteResult as any).out.transactionReceipt,
      );
      expect(voteResult.success).toBe(true);
    }
    await advanceBlocks(votingPeriod + 1);
    log.info(`Voting period ended (${votingPeriod} blocks)`);
    // 7. Queue the proposal
    const queueResult = await connector.invokeContract({
      contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      contractAddress: governorAddress,
      contractAbi: GovernanceWithTimelockContract.abi,
      signingCredential: proposer.credential,
      invocationType: EthContractInvocationType.Send,
      methodName: "queue",
      params: [[policyAddress], [0], [calldata], descHash],
      gas: estimatedGas,
    });
    expect(queueResult.success).toBe(true);

    if (minDelay > 0) {
      log.info(`Waiting ${minDelay + 1} seconds for timelock delay...`);
      await new Promise((resolve) =>
        setTimeout(resolve, (minDelay + 1) * 1000),
      );
    } else {
      // Even with minDelay=0, some contracts require a tiny delay for timestamp checks
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // 9. Execute the proposal
    const executeResult = await connector.invokeContract({
      contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      contractAddress: governorAddress,
      contractAbi: GovernanceWithTimelockContract.abi,
      signingCredential: proposer.credential,
      invocationType: EthContractInvocationType.Send,
      methodName: "execute",
      params: [[policyAddress], [0], [calldata], descHash],
      gas: estimatedGas,
    });
    expect(executeResult.success).toBe(true);

    // 10. Verify parameter was updated
    const finalValue = await getNumber(
      policyAddress,
      "getValue",
      POLICY_REGISTRY_CONTRACT_NAME,
      KEY,
    );
    expect(finalValue).toBe(Number(NEW_VALUE));
    log.info(`Parameter ${KEY} updated to ${finalValue}`);
  });

  async function DeployDao(config: GovernanceConfig): Promise<{
    addresses: DeployedAddresses;
    organizations: OrganizationInfo[];
  }> {
    await keychainPlugin.set(
      TOKEN_CONTRACT_NAME,
      JSON.stringify(TokenContract),
    );

    const keyPair = await besuTestLedger.getBesuKeyPair();
    deployerCredentials = {
      ethAccount: keyPair.publicKey,
      secret: keyPair.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    };

    const deployerAddress = keyPair.publicKey;

    // TOKEN CONTRACT
    const { name, symbol, supply } = config.tokenomics;
    const constructorArgs = [name, symbol, supply.toString(), deployerAddress];

    const deployTokenContract = await connector.deployContract({
      contractName: TOKEN_CONTRACT_NAME,
      contractAbi: TokenContract.abi,
      bytecode: TokenContract.bytecode.object,
      web3SigningCredential: deployerCredentials,
      keychainId,
      constructorArgs,
      gas: estimatedGas,
    });

    if (!deployTokenContract?.transactionReceipt?.contractAddress) {
      throw new Error("Token deployment failed");
    }

    const tokenAddress = deployTokenContract.transactionReceipt.contractAddress;

    expect(tokenAddress).toBeDefined();
    printTxReceipt(deployTokenContract.transactionReceipt, "Token Deployment");
    log.info(`Token deployed at address: ${tokenAddress}`);

    // ----------------------------- TIMELOCK CONTRACT
    const deployTimelockContract = await connector.deployContract({
      contractName: TIMELOCK_CONTRACT_NAME,
      contractAbi: TimelockContract.abi,
      bytecode: TimelockContract.bytecode.object,
      web3SigningCredential: deployerCredentials,
      keychainId,
      constructorArgs: [
        config.timelock.minDelay.toString(),
        [],
        [],
        deployerAddress,
      ],
      gas: estimatedGas,
    });

    if (!deployTimelockContract?.transactionReceipt?.contractAddress) {
      throw new Error("Timelock deployment failed");
    }
    const timelockAddress =
      deployTimelockContract.transactionReceipt.contractAddress;

    expect(timelockAddress).toBeDefined();
    printTxReceipt(
      deployTimelockContract.transactionReceipt,
      "TimeLock Deployment",
    );
    log.info(`TimeLock deployed at address: ${timelockAddress}`);

    // ----------------------------- GATEWAY REGISTRY CONTRACT
    const deployGatewayRegistryContract = await connector.deployContract({
      contractName: GATEWAY_REGISTRY_CONTRACT_NAME,
      contractAbi: GatewayRegistryContract.abi,
      bytecode: GatewayRegistryContract.bytecode.object,
      web3SigningCredential: deployerCredentials,
      keychainId,
      constructorArgs: [deployerAddress],
      gas: estimatedGas,
    });

    if (!deployGatewayRegistryContract?.transactionReceipt?.contractAddress) {
      throw new Error("Gateway Registry deployment failed");
    }
    const gatewayRegistryAddress =
      deployGatewayRegistryContract.transactionReceipt.contractAddress;

    expect(gatewayRegistryAddress).toBeDefined();
    printTxReceipt(
      deployGatewayRegistryContract.transactionReceipt,
      "Gateway Registry Deployment",
    );
    log.info(`Gateway Registry deployed at address: ${gatewayRegistryAddress}`);

    // ----------------------------- POLICY REGISTRY CONTRACT
    const deployPolicyRegistryContract = await connector.deployContract({
      contractName: POLICY_REGISTRY_CONTRACT_NAME,
      contractAbi: PolicyRegistryContract.abi,
      bytecode: PolicyRegistryContract.bytecode.object,
      web3SigningCredential: deployerCredentials,
      keychainId,
      constructorArgs: [deployerAddress],
      gas: estimatedGas,
    });

    if (!deployPolicyRegistryContract?.transactionReceipt?.contractAddress) {
      throw new Error("Policy Registry deployment failed");
    }
    const policyRegistryAddress =
      deployPolicyRegistryContract.transactionReceipt.contractAddress;

    expect(policyRegistryAddress).toBeDefined();
    printTxReceipt(
      deployPolicyRegistryContract.transactionReceipt,
      "Policy Registry Deployment",
    );
    log.info(`Policy Registry deployed at address: ${policyRegistryAddress}`);

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
      GatewayRegistryContract.abi,
      timelockAddress,
    );

    await transferOwnershipToTimelock(
      deployerCredentials,
      POLICY_REGISTRY_CONTRACT_NAME,
      policyRegistryAddress,
      PolicyRegistryContract.abi,
      timelockAddress,
    );

    // ----------------------------- TIMELOCK GOVERNANCE CONTRACT
    const deployGovernanceContract = await connector.deployContract({
      contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      contractAbi: GovernanceWithTimelockContract.abi,
      bytecode: GovernanceWithTimelockContract.bytecode.object,
      web3SigningCredential: deployerCredentials,
      keychainId,
      constructorArgs: [
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
      gas: estimatedGas,
    });

    if (!deployGovernanceContract?.transactionReceipt?.contractAddress) {
      throw new Error("TimeLock Governance deployment failed");
    }
    const governanceTimelockAddress =
      deployGovernanceContract.transactionReceipt.contractAddress;
    deployPolicyRegistryContract.transactionReceipt.contractAddress;

    expect(governanceTimelockAddress).toBeDefined();
    printTxReceipt(
      deployGovernanceContract.transactionReceipt,
      "Governance With Timelock Deployment",
    );
    log.info(
      `Governance With Timelock deployed at address: ${governanceTimelockAddress}`,
    );

    // granting roles

    await configureTimelockRoles(
      deployerCredentials,
      timelockAddress,
      governanceTimelockAddress,
    );
    return {
      addresses: {
        token: tokenAddress,
        timelock: timelockAddress,
        gatewayRegistry: gatewayRegistryAddress,
        policyRegistry: policyRegistryAddress,
        governor: governanceTimelockAddress,
      },
      organizations: orgInfos,
    };
  }

  function printTxReceipt(
    receipt: Web3TransactionReceipt,
    label = "Transaction Receipt",
  ): void {
    console.log(`\n=== ${label} ===`);
    console.log(`Status           : ${receipt.status ? "SUCCESS" : "FAILED"}`);
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
      const orgAccount = await besuTestLedger.createEthTestAccount();
      const orgAddress = orgAccount.address;
      const orgCredential: Web3SigningCredential = {
        ethAccount: orgAddress,
        secret: orgAccount.privateKey,
        type: Web3SigningCredentialType.PrivateKeyHex,
      };
      orgInfos.push({ address: orgAddress, credential: orgCredential });
      log.info(`Org${String.fromCharCode(65 + i)} address: ${orgAddress}`);

      // Transfer tokens to org
      const transfer = await besuApi.invokeContractV1({
        contractName: TOKEN_CONTRACT_NAME,
        contractAddress: tokenContractAddress,
        keychainId,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Send,
        methodName: "transfer",
        params: [orgAddress, config.tokenomics.defaultMemberTokens.toString()],
        gas: estimatedGas,
      });

      expect(transfer.status).toBe(200);
      expect(transfer.data.success).toBe(true);

      log.info(
        `Allocated ${config.tokenomics.defaultMemberTokens} tokens to ${orgAddress}`,
      );

      const delegate = await besuApi.invokeContractV1({
        contractName: TOKEN_CONTRACT_NAME,
        contractAddress: tokenContractAddress,
        keychainId,
        signingCredential: orgCredential,
        invocationType: EthContractInvocationType.Send,
        methodName: "delegate",
        params: [orgAddress],
        gas: estimatedGas,
      });
      if ((delegate.data as any).out?.transactionReceipt) {
        printTxReceipt(
          (delegate.data as any).out?.transactionReceipt,
          `Delegate Voting Power for ${orgAddress}`,
        );
      }
      expect(delegate.status).toBe(200);
      expect(delegate.data.success).toBe(true);

      const balance = await connector.invokeContract({
        contractName: TOKEN_CONTRACT_NAME,
        contractAddress: tokenContractAddress,
        keychainId,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Call,
        methodName: "balanceOf",
        params: [orgAddress],
      });

      log.info(`Balance of ${orgAddress}: ${balance.callOutput}`);

      const registerOrg = await besuApi.invokeContractV1({
        contractName: GATEWAY_REGISTRY_CONTRACT_NAME,
        contractAbi: GatewayRegistryContract.abi,
        contractAddress: gatewayRegistryAddress,
        keychainId,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Send,
        methodName: "registerOrganization",
        params: [orgAddress, "Org" + String.fromCharCode(65 + i), 1000],
        gas: estimatedGas,
      });

      const receipt = (registerOrg.data as any).out?.transactionReceipt;
      if (receipt) {
        printTxReceipt(
          receipt,
          `Register Org${String.fromCharCode(65 + i)} in Gateway Registry`,
        );
      }
      expect(registerOrg.status).toBe(200);
      expect(registerOrg.data.success).toBe(true);
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

    const deployerBalance = await besuApi.invokeContractV1({
      contractName: TOKEN_CONTRACT_NAME,
      contractAddress: tokenContractAddress,
      keychainId,
      signingCredential: deployerCredential,
      invocationType: EthContractInvocationType.Call,
      methodName: "balanceOf",
      params: [deployerAddress],
    });

    const remaining = deployerBalance.data.callOutput;
    log.info(`Deployer remaining token balance: ${remaining}`);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (remaining && remaining !== "0") {
      const transferToTreasury = await besuApi.invokeContractV1({
        contractName: TOKEN_CONTRACT_NAME,
        contractAddress: tokenContractAddress,
        keychainId,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Send,
        methodName: "transfer",
        params: [timelockAddress, remaining],
        gas: estimatedGas,
      });

      const receipt = (transferToTreasury.data as any).out?.transactionReceipt;
      if (receipt) {
        printTxReceipt(
          receipt,
          `Transfer Remaining Tokens to Timelock (Treasury)`,
        );
      }
      const timelockBalance = await besuApi.invokeContractV1({
        contractName: TOKEN_CONTRACT_NAME,
        contractAddress: tokenContractAddress,
        keychainId,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Call,
        methodName: "balanceOf",
        params: [timelockAddress],
      });
      log.info(
        `Timelock token balance after transfer: ${timelockBalance.data.callOutput}`,
      );
    } else {
      log.info("No remaining tokens to transfer to treasury.");
    }
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

      const addParamResult = await besuApi.invokeContractV1({
        contractName: POLICY_REGISTRY_CONTRACT_NAME,
        contractAddress: policyRegistryAddress,
        contractAbi: PolicyRegistryContract.abi,
        keychainId,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Send,
        methodName: "addParameter",
        params: [param.key, parsedValue.toString()],
        gas: estimatedGas,
      });

      expect(addParamResult.status).toBe(200);
      expect(addParamResult.data.success).toBe(true);

      const receipt = (addParamResult.data as any).out?.transactionReceipt;
      if (receipt) {
        printTxReceipt(receipt, `Add Parameter: ${param.key}`);
      }
    }

    log.info("All protocol parameters added successfully.");
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

  async function transferOwnershipToTimelock(
    deployerCredential: Web3SigningCredential,
    contractName: string,
    contractAddress: string,
    contractAbi: any,
    timelockAddress: string,
  ): Promise<void> {
    log.info(`Transferring ownership of ${contractName} to Timelock...`);

    const transferOwnershipResult = await besuApi.invokeContractV1({
      contractName,
      contractAddress,
      contractAbi: contractAbi,
      keychainId,
      signingCredential: deployerCredential,
      invocationType: EthContractInvocationType.Send,
      methodName: "transferOwnership",
      params: [timelockAddress],
      gas: estimatedGas,
    });

    expect(transferOwnershipResult.status).toBe(200);
    expect(transferOwnershipResult.data.success).toBe(true);

    const receipt = (transferOwnershipResult.data as any).out
      ?.transactionReceipt;
    if (receipt) {
      printTxReceipt(
        receipt,
        `Transfer Ownership of ${contractName} to Timelock`,
      );
    }
  }

  function mapVotingSystem(system: string): VotingSystem {
    switch (system) {
      case "quadratic":
        return VotingSystem.Quadratic;
      case "weighted-reputation":
        return VotingSystem.WeightedReputation;
      case "token-based":
      default:
        return VotingSystem.TokenBased;
    }
  }

  async function configureTimelockRoles(
    deployerCredential: Web3SigningCredential,
    timelockAddress: string,
    governorAddress: string,
  ): Promise<void> {
    log.info("Fetching Timelock role identifiers...");

    // Helper to call a view function on the Timelock contract
    const getRole = async (roleFunction: string): Promise<string> => {
      const result = await connector.invokeContract({
        contractName: TIMELOCK_CONTRACT_NAME,
        contractAddress: timelockAddress,
        contractAbi: TimelockContract.abi,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Call,
        methodName: roleFunction,
        params: [],
      });
      // The callOutput is a bytes32 hex string (with '0x' prefix)
      return result.callOutput as string;
    };

    const PROPOSER_ROLE = await getRole("PROPOSER_ROLE");
    const EXECUTOR_ROLE = await getRole("EXECUTOR_ROLE");
    const CANCELLER_ROLE = await getRole("CANCELLER_ROLE");
    const ADMIN_ROLE = await getRole("DEFAULT_ADMIN_ROLE");

    log.info(`PROPOSER_ROLE: ${PROPOSER_ROLE}`);
    log.info(`EXECUTOR_ROLE: ${EXECUTOR_ROLE}`);
    log.info(`CANCELLER_ROLE: ${CANCELLER_ROLE}`);
    log.info(`DEFAULT_ADMIN_ROLE: ${ADMIN_ROLE}`);

    // Helper to grant/revoke roles
    const changeRole = async (
      method: "grantRole" | "revokeRole",
      role: string,
      account: string,
    ) => {
      log.info(`${method} ${role} to ${account}`);
      const result = await besuApi.invokeContractV1({
        contractName: TIMELOCK_CONTRACT_NAME,
        contractAddress: timelockAddress,
        contractAbi: TimelockContract.abi,
        keychainId,
        signingCredential: deployerCredential,
        invocationType: EthContractInvocationType.Send,
        methodName: method,
        params: [role, account],
        gas: estimatedGas,
      });
      expect(result.status).toBe(200);
      expect(result.data.success).toBe(true);
      const receipt = (result.data as any).out?.transactionReceipt;
      if (receipt) {
        printTxReceipt(receipt, `${method} ${role} to ${account}`);
      }
    };

    const deployerAddress = (deployerCredential as any).ethAccount as string;
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

    await changeRole("grantRole", PROPOSER_ROLE, governorAddress);
    await changeRole("grantRole", CANCELLER_ROLE, governorAddress);
    await changeRole("grantRole", EXECUTOR_ROLE, ZERO_ADDRESS);
    await changeRole("revokeRole", ADMIN_ROLE, deployerAddress);

    log.info("Timelock roles configured successfully.");
  }

  function encodeSetParameter(key: string, value: bigint): string {
    const web3 = (connector as any).web3;
    const methodAbi = PolicyRegistryContract.abi.find(
      (m: any) => m.name === "setParameter" && m.type === "function",
    );
    return web3.eth.abi.encodeFunctionCall(methodAbi, [key, value.toString()]);
  }

  function extractProposalId(
    receipt: Web3TransactionReceipt,
    governorAddress: string,
  ): string {
    const web3 = (connector as any).web3;

    // Full event ABI for ProposalCreated (OpenZeppelin Governor)
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

    const eventSig = web3.eth.abi.encodeEventSignature(eventAbi);

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === governorAddress.toLowerCase() &&
        log.topics[0] === eventSig
      ) {
        // Decode the data using the full event ABI
        const decoded = web3.eth.abi.decodeLog(
          eventAbi.inputs,
          log.data,
          [], // no indexed params, so no topics to pass except the signature
        );
        return decoded.proposalId.toString();
      }
    }

    throw new Error("ProposalCreated event not found");
  }

  /**
   * Besu test ledger nao consegui fazer com evm_mine provavelmente por causa das definicoes
   * da ledger?
   * @param n
   */
  async function advanceBlocks(n: number): Promise<void> {
    const web3 = (connector as any).web3;
    const fromAddress = (deployerCredentials as any).ethAccount;
    const privateKey = (deployerCredentials as any).secret;

    for (let i = 0; i < n; i++) {
      const nonce = await web3.eth.getTransactionCount(fromAddress);
      const tx = {
        from: fromAddress,
        to: fromAddress,
        value: "0x0",
        gas: 21000,
        nonce: nonce,
      };
      const signed = await web3.eth.accounts.signTransaction(tx, privateKey);
      await web3.eth.sendSignedTransaction(signed.rawTransaction);
    }
    log.info(`Advanced ${n} blocks via self-transfers`);
  }
});
