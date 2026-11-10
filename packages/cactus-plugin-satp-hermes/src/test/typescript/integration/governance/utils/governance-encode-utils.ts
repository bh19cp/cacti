import Web3 from "web3";
import TokenContract from "../../../../solidity/generated/Token.sol/Token.json";
import GatewayRegistryContract from "../../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import PolicyRegistryContract from "../../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";

function findGatewayAbi(name: string) {
  const abi = GatewayRegistryContract.abi.find(
    (m: any) => m.name === name && m.type === "function",
  );
  if (!abi) throw new Error(`${name} not found in GatewayRegistry ABI`);
  return abi;
}

function findTokenAbi(name: string) {
  const abi = TokenContract.abi.find(
    (m: any) => m.name === name && m.type === "function",
  );
  if (!abi) throw new Error(`${name} not found in Token ABI`);
  return abi;
}

function findPolicyAbi(name: string) {
  const abi = PolicyRegistryContract.abi.find(
    (m: any) => m.name === name && m.type === "function",
  );
  if (!abi) throw new Error(`${name} not found in PolicyRegistry ABI`);
  return abi;
}

// ── GatewayRegistry encoders ────────────────────────────────────────────────
export function encodeRegisterOrganization(
  web3: InstanceType<typeof Web3>,
  wallet: string,
  name: string,
  initialReputation: number,
): string {
  return web3.eth.abi.encodeFunctionCall(
    findGatewayAbi("registerOrganization") as any,
    [wallet, name, initialReputation.toString()],
  );
}

export function encodeSetOrganizationStatus(
  web3: InstanceType<typeof Web3>,
  wallet: string,
  newStatus: number,
  reason: string,
): string {
  return web3.eth.abi.encodeFunctionCall(
    findGatewayAbi("setOrganizationStatus") as any,
    [wallet, newStatus.toString(), reason],
  );
}

export function encodeRemoveOrganization(
  web3: InstanceType<typeof Web3>,
  wallet: string,
  reason: string,
): string {
  return web3.eth.abi.encodeFunctionCall(
    findGatewayAbi("removeOrganization") as any,
    [wallet, reason],
  );
}

export function encodeRegisterGateway(
  web3: InstanceType<typeof Web3>,
  gwPublicKey: string,
  orgWallet: string,
  name: string,
): string {
  const keyBytes = gwPublicKey.startsWith("0x")
    ? gwPublicKey
    : "0x" + gwPublicKey;

  return web3.eth.abi.encodeFunctionCall(
    findGatewayAbi("registerGateway") as any,
    [keyBytes, orgWallet, name],
  );
}

export function encodeSetGatewayStatus(
  web3: InstanceType<typeof Web3>,
  gwPublicKey: string,
  newStatus: number,
  reason: string,
): string {
  const keyBytes = gwPublicKey.startsWith("0x")
    ? gwPublicKey
    : "0x" + gwPublicKey;

  return web3.eth.abi.encodeFunctionCall(
    findGatewayAbi("setGatewayStatus") as any,
    [keyBytes, newStatus.toString(), reason],
  );
}

export function encodeRemoveGateway(
  web3: InstanceType<typeof Web3>,
  gwPublicKey: string,
  reason: string,
): string {
  const keyBytes = gwPublicKey.startsWith("0x")
    ? gwPublicKey
    : "0x" + gwPublicKey;

  return web3.eth.abi.encodeFunctionCall(
    findGatewayAbi("removeGateway") as any,
    [keyBytes, reason],
  );
}

export function encodeAddParameter(
  web3: InstanceType<typeof Web3>,
  key: string,
  value: bigint,
): string {
  return web3.eth.abi.encodeFunctionCall(findPolicyAbi("addParameter") as any, [
    key,
    value.toString(),
  ]);
}

export function encodeSetParameter(
  web3: InstanceType<typeof Web3>,
  key: string,
  value: bigint,
): string {
  return web3.eth.abi.encodeFunctionCall(findPolicyAbi("setParameter") as any, [
    key,
    value.toString(),
  ]);
}

export function encodeRemoveParameter(
  web3: InstanceType<typeof Web3>,
  key: string,
): string {
  return web3.eth.abi.encodeFunctionCall(
    findPolicyAbi("removeParameter") as any,
    [key],
  );
}

export function encodeTransfer(
  web3: InstanceType<typeof Web3>,
  to: string,
  amount: string | number,
): string {
  return web3.eth.abi.encodeFunctionCall(findTokenAbi("transfer") as any, [
    to,
    amount.toString(),
  ]);
}

export function encodeReclaimTokensToAddress(
  web3: InstanceType<typeof Web3>,
  account: string,
  recipient: string,
): string {
  return web3.eth.abi.encodeFunctionCall(
    findTokenAbi("reclaimTokensToAddress") as any,
    [account, recipient],
  );
}

export function encodeBurnAllTokensFromAccount(
  web3: InstanceType<typeof Web3>,
  account: string,
): string {
  return web3.eth.abi.encodeFunctionCall(
    findTokenAbi("burnAllTokensFromAccount") as any,
    [account],
  );
}
