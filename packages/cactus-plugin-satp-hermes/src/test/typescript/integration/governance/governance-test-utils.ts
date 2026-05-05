import Web3, { AbiFunctionFragment } from "web3";
import { ethers } from "ethers";
import {
  EthContractInvocationType,
  Web3SigningCredential,
  Web3SigningCredentialType,
  Web3TransactionReceipt,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { LoggerProvider, LogLevelDesc } from "@hyperledger/cactus-common";
import { SATPGateway } from "../../../../main/typescript";
import { EthereumTestEnvironment } from "../../test-utils";
import { GovernanceConfig } from "./governance-config/governance-config";
import TokenContract from "../../../solidity/generated/Token.sol/Token.json";
import TimelockContract from "../../../solidity/generated/Timelock.sol/Timelock.json";
import GatewayRegistryContract from "../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import PolicyRegistryContract from "../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GovernanceWithTimelockContract from "../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";

export const TOKEN_CONTRACT_NAME = "TokenContract";
export const TIMELOCK_CONTRACT_NAME = "TimelockContract";
export const GATEWAY_REGISTRY_CONTRACT_NAME = "GatewayRegistryContract";
export const POLICY_REGISTRY_CONTRACT_NAME = "PolicyRegistryContract";
export const GOVERNANCE_TIMELOCK_CONTRACT_NAME =
  "GovernanceWithTimelockContract";
export const DEFAULT_GAS = 6721975;
export const DEFAULT_GAS_PRICE = "20000000000"; // 20 gwei

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "governance-test-utils",
});

export interface DeployedAddresses {
  token: string;
  timelock: string;
  gatewayRegistry: string;
  policyRegistry: string;
  governor: string;
}

export interface OrganizationInfo {
  address: string;
  credential: Web3SigningCredential;
}

export interface DeployDaoResult {
  addresses: DeployedAddresses;
  organizations: OrganizationInfo[];
  deployerCredentials: Web3SigningCredential;
}

// ---------------------------------------------------------------------------
// Encoding / event helpers
// ---------------------------------------------------------------------------

export function encodeSetParameter(
  web3: InstanceType<typeof Web3>,
  key: string,
  value: bigint,
): string {
  const methodAbi = PolicyRegistryContract.abi.find(
    (m: any) => m.name === "setParameter" && m.type === "function",
  );
  if (!methodAbi) throw new Error("setParameter function not found in ABI");
  return web3.eth.abi.encodeFunctionCall(methodAbi as any, [
    key,
    value.toString(),
  ]);
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

// ---------------------------------------------------------------------------
// Block / time helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Contract deployment
// ---------------------------------------------------------------------------

export async function deployContract(
  ethereumEnv: EthereumTestEnvironment,
  contractName: string,
  abi: any[],
  bytecode: string,
  credential: Web3SigningCredential,
  constructorArgs: any[] = [],
): Promise<string> {
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

  printTxReceipt(receipt, contractName);
  return receipt.contractAddress;
}

// ---------------------------------------------------------------------------
// DAO setup helpers
// ---------------------------------------------------------------------------

export async function createOrganizations(
  ethereumEnv: EthereumTestEnvironment,
  config: GovernanceConfig,
  deployerCredential: Web3SigningCredential,
  gatewayRegistryAddress: string,
  tokenContractAddress: string,
): Promise<OrganizationInfo[]> {
  const orgInfos: OrganizationInfo[] = [];
  log.info("Creating 3 organizations...");

  for (let i = 0; i < 3; i++) {
    const orgAccount = await ethereumEnv.ledger.createEthTestAccount();
    const orgAddress = orgAccount.address;
    const orgCredential: Web3SigningCredential = {
      ethAccount: orgAddress,
      secret: orgAccount.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    };
    orgInfos.push({ address: orgAddress, credential: orgCredential });
    log.info(`Org${String.fromCharCode(65 + i)} address: ${orgAddress}`);

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
      [orgAddress, config.tokenomics.defaultMemberTokens.toString()],
      tokenContractAddress,
    );
    expect(transferResult.success).toBe(true);

    const delegateResult = await invoke(
      orgCredential,
      "delegate",
      [orgAddress],
      tokenContractAddress,
    );
    expect(delegateResult.success).toBe(true);

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
      params: [orgAddress, "Org" + String.fromCharCode(65 + i), 1000],
      gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
    });
    expect(registerResult.success).toBe(true);
  }

  return orgInfos;
}

export async function sendRemainingTokensToTreasury(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  tokenContractAddress: string,
  timelockAddress: string,
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
  }
}

export async function addProtocolParametersToPolicyRegistry(
  ethereumEnv: EthereumTestEnvironment,
  protocolParameters: GovernanceConfig["protocolParameters"],
  deployerCredential: Web3SigningCredential,
  policyRegistryAddress: string,
): Promise<void> {
  if (!protocolParameters?.length) {
    log.info("No protocol parameters to add.");
    return;
  }

  for (const param of protocolParameters) {
    const parsedValue = parseParameterValue(param.value);
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
  }
}

export async function transferOwnershipToTimelock(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  contractName: string,
  contractAddress: string,
  contractAbi: any,
  timelockAddress: string,
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
}

export async function configureTimelockRoles(
  ethereumEnv: EthereumTestEnvironment,
  deployerCredential: Web3SigningCredential,
  timelockAddress: string,
  governorAddress: string,
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

  const timelockAddress = await deploy(
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

  const gatewayRegistryAddress = await deploy(
    GATEWAY_REGISTRY_CONTRACT_NAME,
    GatewayRegistryContract.abi,
    GatewayRegistryContract.bytecode.object,
    [deployerCredentials.ethAccount],
  );

  const policyRegistryAddress = await deploy(
    POLICY_REGISTRY_CONTRACT_NAME,
    PolicyRegistryContract.abi,
    PolicyRegistryContract.bytecode.object,
    [deployerCredentials.ethAccount],
  );

  const organizations = await createOrganizations(
    ethereumEnv,
    config,
    deployerCredentials,
    gatewayRegistryAddress,
    tokenAddress,
  );

  await sendRemainingTokensToTreasury(
    ethereumEnv,
    deployerCredentials,
    tokenAddress,
    timelockAddress,
  );

  await addProtocolParametersToPolicyRegistry(
    ethereumEnv,
    config.protocolParameters,
    deployerCredentials,
    policyRegistryAddress,
  );

  await transferOwnershipToTimelock(
    ethereumEnv,
    deployerCredentials,
    GATEWAY_REGISTRY_CONTRACT_NAME,
    gatewayRegistryAddress,
    GatewayRegistryContract.abi,
    timelockAddress,
  );

  await transferOwnershipToTimelock(
    ethereumEnv,
    deployerCredentials,
    POLICY_REGISTRY_CONTRACT_NAME,
    policyRegistryAddress,
    PolicyRegistryContract.abi,
    timelockAddress,
  );

  const governorAddress = await deploy(
    GOVERNANCE_TIMELOCK_CONTRACT_NAME,
    GovernanceWithTimelockContract.abi,
    GovernanceWithTimelockContract.bytecode.object,
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
    ethereumEnv,
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
    organizations,
    deployerCredentials,
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
  organizations: OrganizationInfo[];
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
  organizations,
  deployerCredentials,
}: RunVotingParams): Promise<void> {
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

  // --- Fetch governance params ---
  const getNumber = async (method: string, contract: string, abi: any) => {
    const res = await ethereumEnv.connector.invokeContract({
      contract: {
        contractAddress: contract,
        contractJSON: { contractName: "", abi, bytecode: "" },
      },
      invocationType: EthContractInvocationType.Call,
      web3SigningCredential: organizations[0].credential,
      methodName: method,
      params: [],
      gasConfig: {
        gas: DEFAULT_GAS.toString(),
        gasPrice: DEFAULT_GAS_PRICE,
      },
    });
    return Number(res.callOutput);
  };

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
  const proposer = organizations[0];

  // --- Propose ---
  const proposeResult = await invokeGovernor(
    EthContractInvocationType.Send,
    proposer.credential,
    "propose",
    [[targetAddress], [0], [calldata], description],
  );

  const proposeReceipt = (proposeResult as any).out?.transactionReceipt;
  if (!proposeReceipt?.status) throw new Error("Propose failed");

  const proposalId = extractProposalId(web3, proposeReceipt, governorAddress);

  // --- Vote ---
  await advanceBlocks(web3, deployerCredentials, votingDelay + 1);

  for (const org of organizations) {
    const voteResult = await invokeGovernor(
      EthContractInvocationType.Send,
      org.credential,
      "castVote",
      [proposalId, 1],
    );

    if (!(voteResult as any).out?.transactionReceipt?.status) {
      throw new Error(`Vote failed`);
    }
  }

  await advanceBlocks(web3, deployerCredentials, votingPeriod + 1);

  // --- Queue ---
  const queueResult = await invokeGovernor(
    EthContractInvocationType.Send,
    proposer.credential,
    "queue",
    [[targetAddress], [0], [calldata], descHash],
  );

  if (!(queueResult as any).out?.transactionReceipt?.status) {
    throw new Error("Queue failed");
  }

  // --- Timelock wait ---
  const waitMs = minDelay > 0 ? (minDelay + 1) * 1000 : 1000;
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  // --- Execute ---
  const executeResult = await invokeGovernor(
    EthContractInvocationType.Send,
    proposer.credential,
    "execute",
    [[targetAddress], [0], [calldata], descHash],
  );

  log.debug(
    "Run successful voting function result: ",
    JSON.stringify(executeResult, null, 2),
  );
  if (!(executeResult as any).out?.transactionReceipt?.status) {
    throw new Error("Execute failed");
  }
}
export async function registerGatewayViaGovernance(params: {
  ethereumEnv: any;
  web3: InstanceType<typeof Web3>;
  gatewayPublicKey: string;
  gatewayName: string;
  deployedContracts: DeployedAddresses;
  organizations: OrganizationInfo[];
  deployerCredentials: Web3SigningCredential;
  description?: string;
}): Promise<void> {
  const {
    ethereumEnv,
    web3,
    gatewayPublicKey,
    gatewayName,
    deployedContracts,
    organizations,
    deployerCredentials,
    description = `Register gateway ${gatewayName}`,
  } = params;

  // 1. Derive the Ethereum address from the uncompressed public key
  const pkPrefixed = gatewayPublicKey.startsWith("0x")
    ? gatewayPublicKey
    : "0x" + gatewayPublicKey;
  const gatewayAddress = ethers.computeAddress(pkPrefixed);

  // 2. Find the `registerGateway` function fragment
  const registerABI = GatewayRegistryContract.abi.find(
    (item) => item.type === "function" && item.name === "registerGateway",
  ) as AbiFunctionFragment | undefined;

  if (!registerABI) {
    throw new Error(
      "registerGateway function not found in GatewayRegistryContract ABI",
    );
  }

  // 3. Encode the governance proposal calldata
  const registerCalldata = web3.eth.abi.encodeFunctionCall(registerABI, [
    gatewayAddress,
    organizations[0].address,
    gatewayName,
  ]);

  // 4. Execute the full governance vote
  await runSuccessfulVoting({
    ethereumEnv,
    web3,
    governorAddress: deployedContracts.governor,
    timelockAddress: deployedContracts.timelock,
    targetAddress: deployedContracts.gatewayRegistry,
    calldata: registerCalldata,
    description,
    organizations,
    deployerCredentials,
  });
}
