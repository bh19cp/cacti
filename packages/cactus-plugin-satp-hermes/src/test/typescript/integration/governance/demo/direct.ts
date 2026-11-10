import type Web3 from "web3";
import { Web3SigningCredentialPrivateKeyHex } from "@hyperledger/cactus-plugin-ledger-connector-ethereum";

type AnyWeb3 = Pick<Web3, "eth">;

export interface DirectWriteResult {
  revert: string;
  txHash?: string;
  blockNumber?: bigint;
  status?: bigint;
}

function revertData(e: any): string | undefined {
  for (const c of [e, e?.cause, e?.innerError, e?.cause?.cause]) {
    if (typeof c?.signature === "string" && typeof c?.data === "string")
      return c.signature + c.data.replace(/^0x/, "");
    for (const v of [c?.data, c?.data?.data])
      if (typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v)) return v;
  }
  return undefined;
}

function describeRevert(web3: AnyWeb3, abi: any[], e: any): string {
  const data = revertData(e);
  if (!data) return e?.cause?.message ?? e?.message ?? String(e);
  for (const item of abi.filter((i) => i.type === "error")) {
    const types = (item.inputs ?? []).map((i: any) => i.type);
    const selector = web3.eth.abi.encodeFunctionSignature(
      `${item.name}(${types.join(",")})`,
    );
    if (data.slice(0, 10).toLowerCase() !== selector) continue;
    const args = web3.eth.abi.decodeParameters(types, "0x" + data.slice(10));
    return `${item.name}(${types.map((_: string, i: number) => String(args[i])).join(", ")})`;
  }
  return `revert ${data}`;
}


export async function directWrite(
  web3: AnyWeb3,
  caller: Web3SigningCredentialPrivateKeyHex,
  target: string,
  abi: any[],
  method: string,
  params: unknown[],
): Promise<DirectWriteResult> {
  const contract: any = new web3.eth.Contract(abi, target);
  const call = contract.methods[method](...params);

  let revert = "none: the call succeeded";
  try {
    await call.call({ from: caller.ethAccount });
  } catch (e) {
    revert = describeRevert(web3, abi, e);
  }

  const signed = await web3.eth.accounts.signTransaction(
    {
      from: caller.ethAccount,
      to: target,
      data: call.encodeABI(),
      gas: 300_000,
      gasPrice: await web3.eth.getGasPrice(),
      nonce: await web3.eth.getTransactionCount(caller.ethAccount),
      chainId: await web3.eth.getChainId(),
    },
    caller.secret,
  );
  let receipt: any;
  try {
    receipt = await web3.eth.sendSignedTransaction(
      signed.rawTransaction,
      undefined,
      { checkRevertBeforeSending: false },
    );
  } catch (e: any) {
    receipt = e?.receipt;
    if (!receipt) throw e;
  }
  return {
    revert,
    txHash: receipt.transactionHash,
    blockNumber: BigInt(receipt.blockNumber),
    status: BigInt(receipt.status),
  };
}
