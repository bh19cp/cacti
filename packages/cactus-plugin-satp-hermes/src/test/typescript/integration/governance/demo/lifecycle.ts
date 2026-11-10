import Web3 from "web3";
import {
  EthContractInvocationType,
  Web3SigningCredentialPrivateKeyHex,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import {
  submitProposal,
  advanceBlocks,
  ProposalAction,
  DEFAULT_GAS,
  DEFAULT_GAS_PRICE,
  GOVERNANCE_TIMELOCK_CONTRACT_NAME,
} from "../utils/governance-test-utils";
import GovernanceWithTimelockContract from "../../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";
import type { DeployedEnv as DemoEnv } from "./env";

export interface PhaseResult {
  phase: string;
  timeMs: number;
  gasUsed: bigint;
  txHash: string;
  blockNumber: bigint;
  proposalId?: string;
}
export type OnPhase = (r: PhaseResult) => void;

async function invokeGovernor(
  env: DemoEnv,
  cred: Web3SigningCredentialPrivateKeyHex,
  methodName: string,
  params: any[],
) {
  const t0 = Date.now();
  const result = await env.ethereumEnv.connector.invokeContract({
    contract: {
      contractAddress: env.dao.addresses.governor,
      contractJSON: {
        contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
        abi: GovernanceWithTimelockContract.abi,
        bytecode: GovernanceWithTimelockContract.bytecode.object,
      },
    },
    invocationType: EthContractInvocationType.Send,
    web3SigningCredential: cred,
    methodName,
    params,
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });
  const receipt = (result as any).out?.transactionReceipt;
  if (!receipt?.status) throw new Error(`${methodName} reverted`);
  return {
    timeMs: Date.now() - t0,
    gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : 0n,
    txHash: String(receipt.transactionHash),
    blockNumber: BigInt(receipt.blockNumber),
  };
}

export async function runLifecycle(
  env: DemoEnv,
  actions: ProposalAction[],
  description: string,
  onPhase: OnPhase = () => {},
) {
  const { config, dao, web3, orgs } = env;
  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value ?? 0);
  const calldatas = actions.map((a) => a.calldata);
  const descHash = Web3.utils.keccak256(description);
  const phases: PhaseResult[] = [];
  const emit = (r: PhaseResult) => {
    phases.push(r);
    onPhase(r);
  };

  const p = await submitProposal({
    ethereumEnv: env.ethereumEnv,
    web3,
    governorAddress: dao.addresses.governor,
    proposer: orgs[0],
    actions,
    description,
  });
  emit({
    phase: "propose",
    timeMs: p.timeMs,
    gasUsed: p.gasUsed,
    txHash: String(p.receipt.transactionHash),
    blockNumber: BigInt(p.receipt.blockNumber),
    proposalId: p.proposalId,
  });

  await advanceBlocks(
    web3,
    dao.deployerCredentials,
    config.governance.votingDelay + 1,
  );
  for (let i = 0; i < orgs.length; i++) {
    emit({
      phase: "castVote",
      ...(await invokeGovernor(env, orgs[i], "castVote", [p.proposalId, 1])),
    });
  }
  await advanceBlocks(
    web3,
    dao.deployerCredentials,
    config.governance.votingPeriod + 1,
  );

  if (config.timelock.enabled) {
    emit({
      phase: "queue",
      ...(await invokeGovernor(env, orgs[0], "queue", [
        targets,
        values,
        calldatas,
        descHash,
      ])),
    });
    await new Promise((r) =>
      setTimeout(
        r,
        config.timelock.minDelay > 0
          ? (config.timelock.minDelay + 1) * 1000
          : 500,
      ),
    );
  }
  emit({
    phase: "execute",
    ...(await invokeGovernor(env, orgs[0], "execute", [
      targets,
      values,
      calldatas,
      descHash,
    ])),
  });

  return { proposalId: p.proposalId, phases };
}
