import Web3, { AbiFunctionFragment } from "web3";
import { ethers } from "ethers";
import {
  EthContractInvocationType,
  Web3SigningCredential,
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
  Web3TransactionReceipt,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { SATPGateway } from "../../../../../main/typescript";
import { EthereumTestEnvironment } from "../../../test-utils";
import { GovernanceConfig } from "../governance-config/governance-config";
import TokenContract from "../../../../solidity/generated/Token.sol/Token.json";
import TimelockContract from "../../../../solidity/generated/Timelock.sol/Timelock.json";
import GatewayRegistryContract from "../../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import PolicyRegistryContract from "../../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GovernanceWithTimelockContract from "../../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";
import GovernanceContract from "../../../../solidity/generated/Governance.sol/Governance.json";
import { expect } from "@jest/globals";

export const TOKEN_CONTRACT_NAME = "TokenContract";
export const TIMELOCK_CONTRACT_NAME = "TimelockContract";
export const GATEWAY_REGISTRY_CONTRACT_NAME = "GatewayRegistryContract";
export const POLICY_REGISTRY_CONTRACT_NAME = "PolicyRegistryContract";
export const GOVERNANCE_TIMELOCK_CONTRACT_NAME =
  "GovernanceWithTimelockContract";
export const DEFAULT_GAS = 6721975;
export const DEFAULT_GAS_PRICE = "20000000000";

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "governance-test-utils",
});

export interface ProposalAction {
  target: string;
  calldata: string;
  value?: number;
}

/** Result returned by both propose helpers. */
export interface ProposeResult {
  /** The on-chain proposal ID (uint256 as string). */
  proposalId: string;
  /** Raw transaction receipt from the propose tx. */
  receipt: Web3TransactionReceipt;
  /** Gas consumed by the propose transaction. */
  gasUsed: bigint;
  /** Wall-clock time for the propose transaction in milliseconds. */
  timeMs: number;
}

export interface DeployedAddresses {
  token: string;
  timelock: string;
  gatewayRegistry: string;
  policyRegistry: string;
  governor: string;
}

export interface LabeledReceipt {
  label: string;
  receipt: Web3TransactionReceipt;
}

export interface DeployDaoResult {
  addresses: DeployedAddresses;
  deployerCredentials: Web3SigningCredential;
  receipts: LabeledReceipt[];
}

export enum OrgStatus {
  Active = 0,
  Suspended = 1,
  Probation = 2,
  Inactive = 3,
}

export enum GatewayStatus {
  Active = 0,
  Suspended = 1,
  Revoked = 2,
}

export function extractProposalId(
  web3: InstanceType<typeof Web3>,
  receipt: Web3TransactionReceipt,
  governorAddress: string,
): string {
  if (!receipt.logs) throw new Error("Receipt has no logs");

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

  for (const entry of receipt.logs) {
    if (
      entry.address.toLowerCase() === governorAddress.toLowerCase() &&
      entry.topics[0] === eventSig
    ) {
      const decoded: any = web3.eth.abi.decodeLog(
        eventAbi.inputs,
        entry.data,
        [],
      );
      return decoded.proposalId.toString();
    }
  }

  throw new Error("ProposalCreated event not found");
}

export async function advanceBlocks(
  web3: InstanceType<typeof Web3>,
  deployerCredentials: Web3SigningCredential,
  n: number,
): Promise<void> {
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
      nonce,
    };
    const signed = await web3.eth.accounts.signTransaction(tx, privateKey);
    await web3.eth.sendSignedTransaction(signed.rawTransaction);
  }
  log.info(`Advanced ${n} blocks via self-transfers`);
}

export function printTxReceipt(
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

export async function deployContract(
  ethereumEnv: EthereumTestEnvironment,
  contractName: string,
  abi: any[],
  bytecode: string,
  credential: Web3SigningCredential,
  constructorArgs: any[] = [],
): Promise<{ address: string; receipt: Web3TransactionReceipt }> {
  const response = await ethereumEnv.connector.deployContract({
    contract: { contractJSON: { contractName, abi, bytecode } },
    web3SigningCredential: credential,
    constructorArgs,
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });

  const receipt = response.transactionReceipt;
  if (!receipt?.contractAddress) {
    throw new Error(
      `Deployment of ${contractName} failed: no contract address`,
    );
  }
  return { address: receipt.contractAddress, receipt };
}

export async function sendRemainingTokensToTreasury(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  tokenContractAddress: string,
  timelockAddress: string,
  receipts: LabeledReceipt[],
): Promise<void> {
  const deployerAddress = (deployerCredential as any).ethAccount as string;

  const balanceResult = await ethereumEnv.connector.invokeContract({
    contract: {
      contractAddress: tokenContractAddress,
      contractJSON: {
        contractName: TOKEN_CONTRACT_NAME,
        abi: TokenContract.abi,
        bytecode: TokenContract.bytecode.object,
      },
    },
    invocationType: EthContractInvocationType.Call,
    web3SigningCredential: deployerCredential,
    methodName: "balanceOf",
    params: [deployerAddress],
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });

  const remaining = balanceResult.callOutput as string;
  log.info(`Deployer remaining token balance: ${remaining}`);

  if (remaining && remaining !== "0") {
    const transferResult = await ethereumEnv.connector.invokeContract({
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
      gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
    });
    expect(transferResult.success).toBe(true);
    receipts.push({
      label: "Transfer Remaining Tokens",
      receipt: extractReceipt(transferResult),
    });
  }
}

export async function createOrganization(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  tokenContractAddress: string,
  gatewayRegistryAddress: string,
  tokensToTransfer: bigint,
  org: Array<{
    address: string;
    name: string;
    gateways: { publicKey: string; name: string }[];
    reputation?: number;
  }>[0],
): Promise<LabeledReceipt[]> {
  const receipts: LabeledReceipt[] = [];

  const invoke = (
    credential: Web3SigningCredential,
    methodName: string,
    params: any[],
    contractAddress: string,
  ) =>
    ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress,
        contractJSON: {
          contractName: TOKEN_CONTRACT_NAME,
          abi: TokenContract.abi,
          bytecode: TokenContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: credential,
      methodName,
      params,
      gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
    });

  const transferResult = await invoke(
    deployerCredential,
    "transfer",
    [org.address, tokensToTransfer.toString()],
    tokenContractAddress,
  );
  expect(transferResult.success).toBe(true);
  receipts.push({
    label: `Transfer tokens to ${org.name}`,
    receipt: extractReceipt(transferResult),
  });

  const registerResult = await ethereumEnv.connector.invokeContract({
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
    params: [org.address, org.name, org.reputation],
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });
  expect(registerResult.success).toBe(true);
  receipts.push({
    label: `Register ${org.name} in GatewayRegistry`,
    receipt: extractReceipt(registerResult),
  });

  for (const gw of org.gateways) {
    const regGwResult = await registerGateway(
      ethereumEnv,
      deployerCredential,
      gatewayRegistryAddress,
      gw,
      org.address,
    );
    receipts.push(regGwResult);
  }

  return receipts;
}

export async function addProtocolParameter(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  policyRegistryAddress: string,
  param: { key: string; value: string | number | boolean },
): Promise<LabeledReceipt> {
  const parsedValue = parseParameterValue(param.value.toString());
  const result = await ethereumEnv.connector.invokeContract({
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
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });

  expect(result.success).toBe(true);
  return {
    label: "Add Parameter",
    receipt: extractReceipt(result),
  };
}

export async function delegateOrganizationTokens(
  ethereumEnv: EthereumTestEnvironment,
  tokenAddress: string,
  organizationCredentials: Web3SigningCredentialPrivateKeyHex[],
): Promise<void> {
  for (const acc of organizationCredentials) {
    const result = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: tokenAddress,
        contractJSON: {
          contractName: TOKEN_CONTRACT_NAME,
          abi: TokenContract.abi,
          bytecode: TokenContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Send,
      web3SigningCredential: acc,
      methodName: "delegate",
      params: [acc.ethAccount],
      gasConfig: {
        gas: DEFAULT_GAS.toString(),
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

    expect(result.success).toBe(true);
  }
}

export async function bootstrapOrganizations(
  ethereumEnv: EthereumTestEnvironment,
  config: GovernanceConfig,
  deployerCredential: Web3SigningCredential,
  gatewayRegistryAddress: string,
  tokenContractAddress: string,
  labeledReceipts: LabeledReceipt[],
): Promise<void> {
  log.info("Bootstrapping organizations");
  if (!config.organizations || config.organizations.length === 0) {
    log.info("No organisations to create.");
  }
  const tokensPerMember = BigInt(config.tokenomics.defaultMemberTokens ?? 1000);

  for (const orgCfg of config.organizations) {
    const result = await createOrganization(
      ethereumEnv,
      deployerCredential,
      tokenContractAddress,
      gatewayRegistryAddress,
      tokensPerMember,
      orgCfg,
    );
    labeledReceipts.push(...result);
  }
}

/**
 * Adds all protocol parameters from the config.
 * Uses `addProtocolParameter` internally.
 */
export async function addProtocolParametersToPolicyRegistry(
  ethereumEnv: EthereumTestEnvironment,
  protocolParameters: GovernanceConfig["protocolParameters"],
  deployerCredential: Web3SigningCredential,
  policyRegistryAddress: string,
  receipts: LabeledReceipt[],
): Promise<void> {
  if (!protocolParameters || protocolParameters.length === 0) {
    log.info("No protocol parameters to add.");
    return;
  }

  for (const param of protocolParameters) {
    const receipt = await addProtocolParameter(
      ethereumEnv,
      deployerCredential,
      policyRegistryAddress,
      param,
    );
    receipts.push(receipt);
  }
}

export async function transferOwnershipToTimelock(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  contractName: string,
  contractAddress: string,
  contractAbi: any,
  timelockAddress: string,
  receipts: LabeledReceipt[],
): Promise<void> {
  const result = await ethereumEnv.connector.invokeContract({
    contract: {
      contractAddress,
      contractJSON: { contractName, abi: contractAbi, bytecode: "" },
    },
    invocationType: EthContractInvocationType.Send,
    web3SigningCredential: deployerCredential,
    methodName: "transferOwnership",
    params: [timelockAddress],
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });
  expect(result.success).toBe(true);
  receipts.push({
    label: "Transfer Ownership",
    receipt: extractReceipt(result),
  });
}

export async function configureTimelockRoles(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  timelockAddress: string,
  governorAddress: string,
  receipts: LabeledReceipt[],
): Promise<void> {
  const getRole = async (roleFunction: string): Promise<string> => {
    const result = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: timelockAddress,
        contractJSON: {
          contractName: TIMELOCK_CONTRACT_NAME,
          abi: TimelockContract.abi,
          bytecode: TimelockContract.bytecode.object,
        },
      },
      invocationType: EthContractInvocationType.Call,
      web3SigningCredential: deployerCredential,
      methodName: roleFunction,
      params: [],
      gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
    });
    return result.callOutput as string;
  };

  const changeRole = async (
    method: "grantRole" | "revokeRole",
    role: string,
    account: string,
  ) => {
    const result = await ethereumEnv.connector.invokeContract({
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
      gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
    });
    expect(result.success).toBe(true);
    receipts.push({
      label: method === "grantRole" ? "Grant Role" : "Revoke Role",
      receipt: extractReceipt(result),
    });
  };

  const [PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE, ADMIN_ROLE] =
    await Promise.all([
      getRole("PROPOSER_ROLE"),
      getRole("EXECUTOR_ROLE"),
      getRole("CANCELLER_ROLE"),
      getRole("DEFAULT_ADMIN_ROLE"),
    ]);

  const deployerAddress = (deployerCredential as any).ethAccount as string;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  await changeRole("grantRole", PROPOSER_ROLE, governorAddress);
  await changeRole("grantRole", CANCELLER_ROLE, governorAddress);
  await changeRole("grantRole", EXECUTOR_ROLE, ZERO_ADDRESS);
  await changeRole("revokeRole", ADMIN_ROLE, deployerAddress);
}

export function mapVotingSystem(system: string): number {
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

export function parseParameterValue(value: string): bigint {
  if (value === "true") return 1n;
  if (value === "false") return 0n;
  if (!isNaN(Number(value))) return BigInt(value);
  return BigInt(Web3.utils.keccak256(value));
}

export const getGatewayPublicKey = (gw: SATPGateway): string => gw.pubKey;

export async function deployDao(
  ethereumEnv: EthereumTestEnvironment,
  config: GovernanceConfig,
): Promise<DeployDaoResult> {
  log.info("Deploying DAO");

  const labeledReceipts: LabeledReceipt[] = [];
  const account = await ethereumEnv.ledger.createEthTestAccount();
  const deployerCredentials: Web3SigningCredential = {
    ethAccount: account.address,
    secret: account.privateKey,
    type: Web3SigningCredentialType.PrivateKeyHex,
  };

  const deploy = (name: string, abi: any[], bytecode: string, args: any[]) =>
    deployContract(ethereumEnv, name, abi, bytecode, deployerCredentials, args);
  const tokenAddress = await deploy(
    TOKEN_CONTRACT_NAME,
    TokenContract.abi,
    TokenContract.bytecode.object,
    [
      config.tokenomics.name,
      config.tokenomics.symbol,
      config.tokenomics.supply.toString(),
      deployerCredentials.ethAccount,
    ],
  );
  tokenAddress.receipt &&
    labeledReceipts.push({ label: "Token", receipt: tokenAddress.receipt });

  log.info(`deployed token contrct at address ${tokenAddress.address}`);
  const gatewayRegistryAddress = await deploy(
    GATEWAY_REGISTRY_CONTRACT_NAME,
    GatewayRegistryContract.abi,
    GatewayRegistryContract.bytecode.object,
    [deployerCredentials.ethAccount],
  );
  gatewayRegistryAddress.receipt &&
    labeledReceipts.push({
      label: "Gateway Registry",
      receipt: gatewayRegistryAddress.receipt,
    });
  log.info(
    `deployed gateway registry contract at address ${gatewayRegistryAddress.address}`,
  );
  const policyRegistryAddress = await deploy(
    POLICY_REGISTRY_CONTRACT_NAME,
    PolicyRegistryContract.abi,
    PolicyRegistryContract.bytecode.object,
    [deployerCredentials.ethAccount],
  );
  policyRegistryAddress.receipt &&
    labeledReceipts.push({
      label: "Policy Registry",
      receipt: policyRegistryAddress.receipt,
    });
  log.info(
    `deployed policy registry contract at address ${policyRegistryAddress.address}`,
  );
  await bootstrapOrganizations(
    ethereumEnv,
    config,
    deployerCredentials,
    gatewayRegistryAddress.address,
    tokenAddress.address,
    labeledReceipts,
  );
  await addProtocolParametersToPolicyRegistry(
    ethereumEnv,
    config.protocolParameters,
    deployerCredentials,
    policyRegistryAddress.address,
    labeledReceipts,
  );
  let timelockAddress:
    | { address: string; receipt?: Web3TransactionReceipt }
    | undefined;
  let governorAddress: { address: string; receipt?: Web3TransactionReceipt };

  const useTimelock = config.timelock.enabled;

  if (useTimelock) {
    timelockAddress = await deploy(
      TIMELOCK_CONTRACT_NAME,
      TimelockContract.abi,
      TimelockContract.bytecode.object,
      [
        config.timelock.minDelay.toString(),
        [],
        [],
        deployerCredentials.ethAccount,
      ],
    );
    timelockAddress.receipt &&
      labeledReceipts.push({
        label: "Timelock",
        receipt: timelockAddress.receipt,
      });

    await sendRemainingTokensToTreasury(
      ethereumEnv,
      deployerCredentials,
      tokenAddress.address,
      timelockAddress.address,
      labeledReceipts,
    );
    await transferOwnershipToTimelock(
      ethereumEnv,
      deployerCredentials,
      GATEWAY_REGISTRY_CONTRACT_NAME,
      gatewayRegistryAddress.address,
      GatewayRegistryContract.abi,
      timelockAddress.address,
      labeledReceipts,
    );
    await transferOwnershipToTimelock(
      ethereumEnv,
      deployerCredentials,
      POLICY_REGISTRY_CONTRACT_NAME,
      policyRegistryAddress.address,
      PolicyRegistryContract.abi,
      timelockAddress.address,
      labeledReceipts,
    );

    await transferOwnershipToTimelock(
      ethereumEnv,
      deployerCredentials,
      TOKEN_CONTRACT_NAME,
      tokenAddress.address,
      TokenContract.abi,
      timelockAddress.address,
      labeledReceipts,
    );

    governorAddress = await deploy(
      GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      GovernanceWithTimelockContract.abi,
      GovernanceWithTimelockContract.bytecode.object,
      [
        config.name,
        tokenAddress.address,
        timelockAddress.address,
        config.governance.votingDelay,
        config.governance.votingPeriod,
        config.governance.proposalThreshold,
        config.governance.quorumFraction,
        mapVotingSystem(config.governance.votingSystem),
        gatewayRegistryAddress.address,
      ],
    );
    governorAddress.receipt &&
      labeledReceipts.push({
        label: "Governor (with Timelock)",
        receipt: governorAddress.receipt,
      });

    await configureTimelockRoles(
      ethereumEnv,
      deployerCredentials,
      timelockAddress.address,
      governorAddress.address,
      labeledReceipts,
    );
  } else {
    governorAddress = await deploy(
      "GovernorContract",
      GovernanceContract.abi,
      GovernanceContract.bytecode.object,
      [
        config.name,
        tokenAddress.address,
        config.governance.votingDelay,
        config.governance.votingPeriod,
        config.governance.proposalThreshold,
        config.governance.quorumFraction,
        mapVotingSystem(config.governance.votingSystem),
        gatewayRegistryAddress.address,
      ],
    );
    governorAddress.receipt &&
      labeledReceipts.push({
        label: "Governor (no Timelock)",
        receipt: governorAddress.receipt,
      });
  }

  return {
    addresses: {
      token: tokenAddress.address,
      timelock: useTimelock ? timelockAddress!.address : ethers.ZeroAddress,
      gatewayRegistry: gatewayRegistryAddress.address,
      policyRegistry: policyRegistryAddress.address,
      governor: governorAddress.address,
    },
    deployerCredentials,
    receipts: labeledReceipts,
  };
}

/**
 * Deploy only the required governance contracts – no organisations, no
 * protocol parameters, no treasury‑transfers, no ownership‑transfers, and
 * no role‑configuration after the governor is created.
 */
export async function deployContractsOnly(
  ethereumEnv: EthereumTestEnvironment,
  config: GovernanceConfig,
): Promise<DeployDaoResult> {
  const labeledReceipts: LabeledReceipt[] = [];
  const account = await ethereumEnv.ledger.createEthTestAccount();
  const credentials: Web3SigningCredential = {
    ethAccount: account.address,
    secret: account.privateKey,
    type: Web3SigningCredentialType.PrivateKeyHex,
  };

  const deploy = (name: string, abi: any[], bytecode: string, args: any[]) =>
    deployContract(ethereumEnv, name, abi, bytecode, credentials, args);

  const tokenR = await deploy(
    TOKEN_CONTRACT_NAME,
    TokenContract.abi,
    TokenContract.bytecode.object,
    [
      config.tokenomics.name,
      config.tokenomics.symbol,
      config.tokenomics.supply.toString(),
      credentials.ethAccount,
    ],
  );
  tokenR.receipt &&
    labeledReceipts.push({ label: "Token", receipt: tokenR.receipt });

  const gwr = await deploy(
    GATEWAY_REGISTRY_CONTRACT_NAME,
    GatewayRegistryContract.abi,
    GatewayRegistryContract.bytecode.object,
    [credentials.ethAccount],
  );
  gwr.receipt &&
    labeledReceipts.push({ label: "Gateway Registry", receipt: gwr.receipt });

  const pr = await deploy(
    POLICY_REGISTRY_CONTRACT_NAME,
    PolicyRegistryContract.abi,
    PolicyRegistryContract.bytecode.object,
    [credentials.ethAccount],
  );
  pr.receipt &&
    labeledReceipts.push({ label: "Policy Registry", receipt: pr.receipt });

  const useTimelock = config.timelock.enabled;
  let timelockAddr: string;
  let governorR: { address: string; receipt?: Web3TransactionReceipt };

  if (useTimelock) {
    const tl = await deploy(
      TIMELOCK_CONTRACT_NAME,
      TimelockContract.abi,
      TimelockContract.bytecode.object,
      [config.timelock.minDelay.toString(), [], [], credentials.ethAccount],
    );
    timelockAddr = tl.address;
    tl.receipt &&
      labeledReceipts.push({ label: "Timelock", receipt: tl.receipt });
    governorR = await deploy(
      GOVERNANCE_TIMELOCK_CONTRACT_NAME,
      GovernanceWithTimelockContract.abi,
      GovernanceWithTimelockContract.bytecode.object,
      [
        config.name,
        tokenR.address,
        timelockAddr,
        config.governance.votingDelay,
        config.governance.votingPeriod,
        config.governance.proposalThreshold,
        config.governance.quorumFraction,
        mapVotingSystem(config.governance.votingSystem),
        gwr.address,
      ],
    );
    governorR.receipt &&
      labeledReceipts.push({
        label: "Governor (with Timelock)",
        receipt: governorR.receipt,
      });
  } else {
    governorR = await deploy(
      "GovernorContract",
      GovernanceContract.abi,
      GovernanceContract.bytecode.object,
      [
        config.name,
        tokenR.address,
        config.governance.votingDelay,
        config.governance.votingPeriod,
        config.governance.proposalThreshold,
        config.governance.quorumFraction,
        mapVotingSystem(config.governance.votingSystem),
        gwr.address,
      ],
    );
    governorR.receipt &&
      labeledReceipts.push({
        label: "Governor (no Timelock)",
        receipt: governorR.receipt,
      });
  }

  return {
    addresses: {
      token: tokenR.address,
      timelock: useTimelock ? timelockAddr! : ethers.ZeroAddress,
      gatewayRegistry: gwr.address,
      policyRegistry: pr.address,
      governor: governorR.address,
    },
    deployerCredentials: credentials,
    receipts: labeledReceipts,
  };
}
export interface RunVotingParams {
  ethereumEnv: EthereumTestEnvironment;
  web3: InstanceType<typeof Web3>;
  governorAddress: string;
  timelockAddress: string;
  targetAddress: string;
  calldata: string;
  description: string;
  organizationsCredentials: Web3SigningCredential[];
  deployerCredentials: Web3SigningCredential;
}

export async function runSuccessfulVoting({
  ethereumEnv,
  web3,
  governorAddress,
  timelockAddress,
  targetAddress,
  calldata,
  description,
  organizationsCredentials,
  deployerCredentials,
}: RunVotingParams): Promise<{ gasUsed: bigint; executeTimestamp: number }> {
  const extractGas = (result: any): bigint => {
    const receipt = result?.out?.transactionReceipt;
    return receipt?.gasUsed ? BigInt(receipt.gasUsed) : 0n;
  };
  const invokeGovernor = (
    invocationType: EthContractInvocationType,
    credential: Web3SigningCredential,
    methodName: string,
    params: any[],
  ) =>
    ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: governorAddress,
        contractJSON: {
          contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
          abi: GovernanceWithTimelockContract.abi,
          bytecode: GovernanceWithTimelockContract.bytecode.object,
        },
      },
      invocationType,
      web3SigningCredential: credential,
      methodName,
      params,
      gasConfig: {
        gas: DEFAULT_GAS.toString(),
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });

  const getNumber = async (method: string, contract: string, abi: any) => {
    const res = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: contract,
        contractJSON: { contractName: "", abi, bytecode: "" },
      },
      invocationType: EthContractInvocationType.Call,
      web3SigningCredential: deployerCredentials,
      methodName: method,
      params: [],
      gasConfig: {
        gas: DEFAULT_GAS.toString(),
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });
    return Number(res.callOutput);
  };

  log.debug("Fetching governance parameters...");
  const votingDelay = await getNumber(
    "votingDelay",
    governorAddress,
    GovernanceWithTimelockContract.abi,
  );
  const votingPeriod = await getNumber(
    "votingPeriod",
    governorAddress,
    GovernanceWithTimelockContract.abi,
  );
  const minDelay = await getNumber(
    "getMinDelay",
    timelockAddress,
    TimelockContract.abi,
  );

  const descHash = Web3.utils.keccak256(description);

  let totalGas = 0n;
  log.debug("Proposing...");
  const proposeResult = await invokeGovernor(
    EthContractInvocationType.Send,
    deployerCredentials,
    "propose",
    [[targetAddress], [0], [calldata], description],
  );
  const proposeReceipt = (proposeResult as any).out?.transactionReceipt;
  if (!proposeReceipt?.status) throw new Error("Propose failed");
  totalGas += extractGas(proposeResult);

  const proposalId = extractProposalId(web3, proposeReceipt, governorAddress);
  await advanceBlocks(web3, deployerCredentials, votingDelay + 1);

  for (const orgCredential of organizationsCredentials) {
    log.debug(`Casting vote from ${orgCredential}...`);
    const voteResult = await invokeGovernor(
      EthContractInvocationType.Send,
      orgCredential,
      "castVote",
      [proposalId, 1],
    );
    if (!(voteResult as any).out?.transactionReceipt?.status) {
      throw new Error(`Vote failed`);
    }
    totalGas += extractGas(voteResult);
  }

  log.debug(`Votes cast, advancing blocks to end voting period...`);
  await advanceBlocks(web3, deployerCredentials, votingPeriod + 1);

  const queueResult = await invokeGovernor(
    EthContractInvocationType.Send,
    deployerCredentials,
    "queue",
    [[targetAddress], [0], [calldata], descHash],
  );
  if (!(queueResult as any).out?.transactionReceipt?.status) {
    throw new Error("Queue failed");
  }
  totalGas += extractGas(queueResult);

  log.debug(`Waiting for minDelay (${minDelay}s)...`);
  const waitMs = minDelay > 0 ? (minDelay + 1) * 1000 : 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const executeTimestamp = Date.now();
  const executeResult = await invokeGovernor(
    EthContractInvocationType.Send,
    deployerCredentials,
    "execute",
    [[targetAddress], [0], [calldata], descHash],
  );
  const executeReceipt = (executeResult as any).out?.transactionReceipt;
  if (!executeReceipt?.status) throw new Error("Execute failed");
  totalGas += extractGas(executeResult);

  log.debug("Run successful voting function total gas:", totalGas.toString());

  return { gasUsed: totalGas, executeTimestamp: executeTimestamp };
}
export async function registerGatewayViaGovernance(params: {
  ethereumEnv: any;
  web3: InstanceType<typeof Web3>;
  gatewayPublicKey: string;
  gatewayName: string;
  orgAddress: string;
  deployedContracts: DeployedAddresses;
  organizationsCredentials: Web3SigningCredential[];
  deployerCredentials: Web3SigningCredential;
  description?: string;
}): Promise<{ gasUsed: bigint }> {
  const {
    ethereumEnv,
    web3,
    gatewayPublicKey,
    gatewayName,
    orgAddress,
    deployedContracts,
    organizationsCredentials,
    deployerCredentials,
    description = `Register gateway ${gatewayName}`,
  } = params;

  const pkPrefixed = gatewayPublicKey.startsWith("0x")
    ? gatewayPublicKey
    : "0x" + gatewayPublicKey;
  const gatewayAddress = ethers.computeAddress(pkPrefixed);

  const registerABI = GatewayRegistryContract.abi.find(
    (item) => item.type === "function" && item.name === "registerGateway",
  ) as AbiFunctionFragment | undefined;
  if (!registerABI) {
    throw new Error("registerGateway function not found in ABI");
  }
  const registerCalldata = web3.eth.abi.encodeFunctionCall(registerABI, [
    gatewayAddress,
    orgAddress,
    gatewayName,
  ]);
  return await runSuccessfulVoting({
    ethereumEnv,
    web3,
    governorAddress: deployedContracts.governor,
    timelockAddress: deployedContracts.timelock,
    targetAddress: deployedContracts.gatewayRegistry,
    calldata: registerCalldata,
    description,
    organizationsCredentials,
    deployerCredentials,
  });
}

function extractReceipt(result: any): Web3TransactionReceipt {
  const receipt = result?.out?.transactionReceipt;
  if (!receipt) {
    throw new Error("Transaction receipt not found in connector response");
  }
  return receipt;
}

export async function registerGateway(
  ethereumEnv: EthereumTestEnvironment,
  ownerCredential: Web3SigningCredential,
  gatewayRegistryAddress: string,
  gateway: { publicKey: string; name: string },
  orgWallet: string,
): Promise<LabeledReceipt> {
  const publicKeyHex = gateway.publicKey.startsWith("0x")
    ? gateway.publicKey
    : "0x" + gateway.publicKey;

  log.info(
    `Registering gateway ${gateway.name} with address ${gateway.publicKey} for org ${orgWallet}...`,
  );
  const result = await ethereumEnv.connector.invokeContract({
    contract: {
      contractAddress: gatewayRegistryAddress,
      contractJSON: {
        contractName: GATEWAY_REGISTRY_CONTRACT_NAME,
        abi: GatewayRegistryContract.abi,
        bytecode: GatewayRegistryContract.bytecode.object,
      },
    },
    invocationType: EthContractInvocationType.Send,
    web3SigningCredential: ownerCredential,
    methodName: "registerGateway",
    params: [publicKeyHex, orgWallet, gateway.name],
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });

  expect(result.success).toBe(true);
  return {
    label: `Direct registration: gateway of gateway  ${gateway.name} with address ${publicKeyHex} for org ${orgWallet}`,
    receipt: extractReceipt(result),
  };
}

export async function publicKeyToAddress(pubKeyHex: string): Promise<string> {
  try {
    const prefixed = pubKeyHex.startsWith("0x") ? pubKeyHex : "0x" + pubKeyHex;
    const computeAddress =
      (ethers as any).computeAddress || (ethers as any).utils?.computeAddress;
    if (!computeAddress) {
      log.info(
        "unable to compute address from public key: ethers.computeAddress not found",
      );
      return "";
    }
    return computeAddress(prefixed);
  } catch (err) {
    log.info(
      "Error computing address from public key: ethers.computeAddress not found",
    );
    return "";
  }
}

export async function submitProposal(params: {
  ethereumEnv: EthereumTestEnvironment;
  web3: InstanceType<typeof Web3>;
  governorAddress: string;
  proposer: Web3SigningCredential;
  actions: ProposalAction[];
  description: string;
}): Promise<ProposeResult> {
  const { ethereumEnv, web3, governorAddress, proposer, actions, description } =
    params;

  if (actions.length === 0) {
    throw new Error("submitProposal: actions array must not be empty");
  }

  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value ?? 0);
  const calldatas = actions.map((a) => a.calldata);

  log.info(
    `Submitting proposal (${actions.length} action(s)): "${description}"`,
  );

  const t0 = Date.now();

  const result = await ethereumEnv.connector.invokeContract({
    contract: {
      contractAddress: governorAddress,
      contractJSON: {
        contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
        abi: GovernanceWithTimelockContract.abi,
        bytecode: GovernanceWithTimelockContract.bytecode.object,
      },
    },
    invocationType: EthContractInvocationType.Send,
    web3SigningCredential: proposer,
    methodName: "propose",
    params: [targets, values, calldatas, description],
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });

  const t1 = Date.now();

  const receipt: Web3TransactionReceipt = (result as any).out
    ?.transactionReceipt;
  if (!receipt?.status) {
    throw new Error(`Propose transaction failed: "${description}"`);
  }

  const gasUsed = receipt.gasUsed ? BigInt(receipt.gasUsed) : 0n;
  const proposalId = extractProposalId(web3, receipt, governorAddress);

  log.info(
    `Proposal submitted — id: ${proposalId}, ${t1 - t0} ms, ${gasUsed.toLocaleString()} gas`,
  );

  return { proposalId, receipt, gasUsed, timeMs: t1 - t0 };
}
