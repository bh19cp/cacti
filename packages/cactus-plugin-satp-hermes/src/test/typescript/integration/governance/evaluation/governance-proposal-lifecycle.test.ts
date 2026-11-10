import "jest-extended";
import Web3 from "web3";
import {
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import { EthereumTestEnvironment } from "../../../test-utils";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../../environments/ethereum-test-environment";
import {
  DeployDaoResult,
  deployDao,
  delegateOrganizationTokens,
  submitProposal,
  advanceBlocks,
  printTxReceipt,
  OrgStatus,
  GatewayStatus,
  ProposalAction,
  DEFAULT_GAS,
  DEFAULT_GAS_PRICE,
  GOVERNANCE_TIMELOCK_CONTRACT_NAME,
} from "../utils/governance-test-utils";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { GovernanceConfig } from "../governance-config/governance-config";
import {
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
  EthContractInvocationType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import {
  encodeRegisterOrganization,
  encodeSetOrganizationStatus,
  encodeRemoveOrganization,
  encodeSetParameter,
  encodeSetGatewayStatus,
  encodeRegisterGateway,
  encodeRemoveGateway,
  encodeAddParameter,
  encodeRemoveParameter,
  encodeTransfer,
  encodeReclaimTokensToAddress,
  encodeBurnAllTokensFromAccount,
} from "../utils/governance-encode-utils";
import GovernanceWithTimelockContract from "../../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";
import { bufArray2HexStr } from "../../../../../main/typescript";

const TIMEOUT = 12_000_000;
const RUNS = 50;
const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Voting Lifecycle Benchmarks",
});

type Operation =
  | "addParameter"
  | "setParameter"
  | "removeParameter"
  | "registerOrganization"
  | "setOrganizationStatus"
  | "removeOrganization"
  | "registerGateway"
  | "setGatewayStatus"
  | "removeGateway";

type LifecyclePhase =
  | "propose"
  | "castVote_0"
  | "castVote_1"
  | "castVote_2"
  | "queue"
  | "execute";

interface BenchmarkRun {
  operation: Operation;
  label: string;
  run: number;
  lifecyclePhase: LifecyclePhase;
  proposalId: string;
  timeMs: number;
  gasUsed: bigint;
}

const results: BenchmarkRun[] = [];

let ethereumEnv: EthereumTestEnvironment;
let dao: DeployDaoResult;
let web3: InstanceType<typeof Web3>;
let organizationsCredentials: Web3SigningCredentialPrivateKeyHex[] = [];

let ORG_A: { address: string; privateKey: string; name: string };
let ORG_B: { address: string; privateKey: string; name: string };
let ORG_C: { address: string; privateKey: string; name: string };

const DAO_CONFIG: GovernanceConfig = {
  name: "GatewayDAO",
  tokenomics: {
    name: "GovernanceToken",
    symbol: "GOV",
    supply: 1_000_000,
    defaultMemberTokens: 1000,
  },
  organizations: [],
  governance: {
    votingSystem: "token-based",
    votingDelay: 1,
    votingPeriod: 5,
    proposalThreshold: 1,
    quorumFraction: 0,
  },
  timelock: {
    enabled: true,
    minDelay: 0,
  },
  protocolParameters: [
    { key: "satp.version", value: "v02" },
    { key: "satp.session.lockExpirationTime", value: "34" },
    { key: "signingAlgorithm", value: "UNSPECIFIED" },
    { key: "claimFormat", value: "2" },
  ],
};

async function invokeGovernor(
  credential: Web3SigningCredentialPrivateKeyHex,
  methodName: string,
  params: any[],
): Promise<{ gasUsed: bigint; timeMs: number; receipt: any }> {
  const t0 = Date.now();
  const result = await ethereumEnv.connector.invokeContract({
    contract: {
      contractAddress: dao.addresses.governor,
      contractJSON: {
        contractName: GOVERNANCE_TIMELOCK_CONTRACT_NAME,
        abi: GovernanceWithTimelockContract.abi,
        bytecode: GovernanceWithTimelockContract.bytecode.object,
      },
    },
    invocationType: EthContractInvocationType.Send,
    web3SigningCredential: credential,
    methodName,
    params,
    gasConfig: { gas: DEFAULT_GAS.toString(), gasPrice: DEFAULT_GAS_PRICE },
  });
  const t1 = Date.now();
  const receipt = (result as any).out?.transactionReceipt;
  const gasUsed = receipt?.gasUsed ? BigInt(receipt.gasUsed) : 0n;
  return { gasUsed, timeMs: t1 - t0, receipt };
}

async function runLifecycle(
  operation: Operation,
  label: string,
  actions: ProposalAction[],
  description: string,
  runIndex: number,
): Promise<BenchmarkRun[]> {
  const phaseResults: BenchmarkRun[] = [];
  const targets = actions.map((a) => a.target);
  const values = actions.map((a) => a.value ?? 0);
  const calldatas = actions.map((a) => a.calldata);
  const descHash = Web3.utils.keccak256(description);
  const record = runIndex >= 0;

  const {
    proposalId,
    gasUsed: proposeGas,
    timeMs: proposeTime,
    receipt: proposeReceipt,
  } = await submitProposal({
    ethereumEnv,
    web3,
    governorAddress: dao.addresses.governor,
    proposer: organizationsCredentials[0],
    actions,
    description,
  });

  if (record) {
    phaseResults.push({
      operation,
      label,
      run: runIndex,
      lifecyclePhase: "propose",
      proposalId,
      timeMs: proposeTime,
      gasUsed: proposeGas,
    });
  }
  printTxReceipt(proposeReceipt, `Propose — ${operation} [run ${runIndex}]`);

  await advanceBlocks(
    web3,
    dao.deployerCredentials,
    DAO_CONFIG.governance.votingDelay + 1,
  );

  for (let i = 0; i < organizationsCredentials.length; i++) {
    const { gasUsed, timeMs, receipt } = await invokeGovernor(
      organizationsCredentials[i],
      "castVote",
      [proposalId, 1],
    );
    if (record) {
      phaseResults.push({
        operation,
        label,
        run: runIndex,
        lifecyclePhase: `castVote_${i}` as LifecyclePhase,
        proposalId,
        timeMs,
        gasUsed,
      });
    }
    printTxReceipt(
      receipt,
      `castVote org #${i} — ${operation} [run ${runIndex}]`,
    );
    expect(receipt.status).toBe(true);
  }

  await advanceBlocks(
    web3,
    dao.deployerCredentials,
    DAO_CONFIG.governance.votingPeriod + 1,
  );

  const {
    gasUsed: queueGas,
    timeMs: queueTime,
    receipt: queueReceipt,
  } = await invokeGovernor(organizationsCredentials[0], "queue", [
    targets,
    values,
    calldatas,
    descHash,
  ]);
  if (record) {
    phaseResults.push({
      operation,
      label,
      run: runIndex,
      lifecyclePhase: "queue",
      proposalId,
      timeMs: queueTime,
      gasUsed: queueGas,
    });
  }
  printTxReceipt(queueReceipt, `Queue — ${operation} [run ${runIndex}]`);

  const waitMs =
    DAO_CONFIG.timelock.minDelay > 0
      ? (DAO_CONFIG.timelock.minDelay + 1) * 1000
      : 500;
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  const {
    gasUsed: execGas,
    timeMs: execTime,
    receipt: execReceipt,
  } = await invokeGovernor(organizationsCredentials[0], "execute", [
    targets,
    values,
    calldatas,
    descHash,
  ]);
  if (record) {
    phaseResults.push({
      operation,
      label,
      run: runIndex,
      lifecyclePhase: "execute",
      proposalId,
      timeMs: execTime,
      gasUsed: execGas,
    });
  }
  printTxReceipt(execReceipt, `Execute — ${operation} [run ${runIndex}]`);

  expect(proposeReceipt.status).toBe(true);
  expect(queueReceipt.status).toBe(true);
  expect(execReceipt.status).toBe(true);
  expect(proposeGas).toBeGreaterThan(0n);
  expect(proposalId).toBeTruthy();

  return phaseResults;
}

async function benchmarkOperation(
  operation: Operation,
  label: string,
  buildContext: (run: number) => Promise<{
    setupActions?: ProposalAction[];
    setupDescription?: string;
    actions: ProposalAction[];
    description: string;
  }>,
): Promise<void> {
  for (let run = 1; run <= RUNS; run++) {
    log.info(`[${operation}] ── run ${run}/${RUNS} ──`);
    const ctx = await buildContext(run);

    if (ctx.setupActions && ctx.setupDescription) {
      await runLifecycle(
        operation,
        "setup",
        ctx.setupActions,
        ctx.setupDescription,
        -1,
      );
    }

    const phaseResults = await runLifecycle(
      operation,
      label,
      ctx.actions,
      ctx.description,
      run,
    );
    results.push(...phaseResults);

    log.info(
      `[${operation}] run ${run}/${RUNS} done — ` +
        phaseResults
          .map(
            (p) =>
              `${p.lifecyclePhase}: ${p.timeMs}ms / ${p.gasUsed.toLocaleString()} gas`,
          )
          .join(", "),
    );
  }
}

const CSV_HEADER =
  "operation,label,run,lifecyclePhase,timeMs,gasUsed,proposalId";

function toCsvRow(r: BenchmarkRun): string {
  const safeLabel = `"${r.label.replace(/"/g, '""')}"`;
  return [
    r.operation,
    safeLabel,
    r.run,
    r.lifecyclePhase,
    r.timeMs,
    r.gasUsed.toString(),
    r.proposalId,
  ].join(",");
}

beforeAll(async () => {
  ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
    { logLevel },
    [
      {
        assetType: SupportedEthereumContractTypes.FUNGIBLE,
        contractName: "SATPContract",
      },
      {
        assetType: SupportedEthereumContractTypes.NONFUNGIBLE,
        contractName: "SATPNFTContract",
      },
    ],
  );
  log.info("Ethereum ledger started");
  await ethereumEnv.deployAndSetupContracts(1);

  web3 = (ethereumEnv.connector as any).web3;

  const ORG_A_account = await ethereumEnv.ledger.createEthTestAccount();
  const ORG_B_account = await ethereumEnv.ledger.createEthTestAccount();
  const ORG_C_account = await ethereumEnv.ledger.createEthTestAccount();

  organizationsCredentials = [
    {
      ethAccount: ORG_A_account.address,
      secret: ORG_A_account.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    },
    {
      ethAccount: ORG_B_account.address,
      secret: ORG_B_account.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    },
    {
      ethAccount: ORG_C_account.address,
      secret: ORG_C_account.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    },
  ];

  ORG_A = {
    address: ORG_A_account.address,
    name: "Organization A",
    privateKey: ORG_A_account.privateKey,
  };
  ORG_B = {
    address: ORG_B_account.address,
    name: "Organization B",
    privateKey: ORG_B_account.privateKey,
  };
  ORG_C = {
    address: ORG_C_account.address,
    name: "Organization C",
    privateKey: ORG_C_account.privateKey,
  };

  const keypairA = Secp256k1Keys.generateKeyPairsBuffer();
  const gatewayPublicKeyA = bufArray2HexStr(keypairA.publicKey);
  const keypairB = Secp256k1Keys.generateKeyPairsBuffer();
  const gatewayPublicKeyB = bufArray2HexStr(keypairB.publicKey);
  const keypairC = Secp256k1Keys.generateKeyPairsBuffer();
  const gatewayPublicKeyC = bufArray2HexStr(keypairC.publicKey);

  DAO_CONFIG.organizations = [
    {
      address: ORG_A_account.address,
      name: ORG_A.name,
      gateways: [{ publicKey: gatewayPublicKeyA, name: "Gateway A" }],
      reputation: 1000,
    },
    {
      address: ORG_B_account.address,
      name: ORG_B.name,
      gateways: [{ publicKey: gatewayPublicKeyB, name: "Gateway B" }],
      reputation: 1000,
    },
    {
      address: ORG_C_account.address,
      name: ORG_C.name,
      gateways: [{ publicKey: gatewayPublicKeyC, name: "Gateway C" }],
      reputation: 1000,
    },
  ];

  const t0 = Date.now();
  dao = await deployDao(ethereumEnv, DAO_CONFIG);
  const t1 = Date.now();

  await delegateOrganizationTokens(
    ethereumEnv,
    dao.addresses.token,
    organizationsCredentials,
  );

  const deployGas = dao.receipts.reduce(
    (acc, { receipt }) => acc + BigInt(receipt.gasUsed ?? 0),
    BigInt(0),
  );
  log.info(`DAO deployed in ${t1 - t0} ms (${deployGas.toLocaleString()} gas)`);
  dao.receipts.forEach(({ label, receipt }) => printTxReceipt(receipt, label));
}, TIMEOUT);

afterAll(async () => {
  const outputDir = path.join(__dirname, "evaluation-results");
  try {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    const csvPath = path.join(
      outputDir,
      `voting-lifecycle-benchmark-${timestamp}.csv`,
    );
    const csvBody = results.map(toCsvRow).join("\n");
    await fs.promises.writeFile(csvPath, `${CSV_HEADER}\n${csvBody}\n`);
    log.info(`CSV saved → ${csvPath}`);

    const jsonPath = path.join(
      outputDir,
      `voting-lifecycle-benchmark-${timestamp}.json`,
    );
    await fs.promises.writeFile(
      jsonPath,
      JSON.stringify(
        {
          runAt: new Date().toISOString(),
          runs: RUNS,
          description: `Gas and latency per phase of full governance lifecycle (${RUNS} runs each)`,
          environment: "Local Ethereum test network",
          gasPrice: DEFAULT_GAS_PRICE,
          benchmarks: results,
        },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2,
      ),
    );
    log.info(`JSON saved → ${jsonPath}`);
  } catch (err) {
    log.error(`Failed to save benchmark results: ${err}`);
  }

  type Key = `${string}::${string}`;
  const buckets = new Map<Key, BenchmarkRun[]>();
  for (const r of results) {
    const key: Key = `${r.operation}::${r.lifecyclePhase}`;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }

  log.info(
    "══════════════════════════════════════════════════════════════════════════",
  );
  log.info(` SUMMARY  (${RUNS} runs per operation)`);
  log.info(
    "──────────────────────────────────────────────────────────────────────────",
  );
  log.info(
    "Operation            | Phase        | Avg ms | Avg gas        | Min gas        | Max gas",
  );
  for (const [key, bucket] of buckets) {
    const [op, phase] = key.split("::");
    const avgMs = Math.round(
      bucket.reduce((s, r) => s + r.timeMs, 0) / bucket.length,
    );
    const avgGas =
      bucket.reduce((s, r) => s + r.gasUsed, 0n) / BigInt(bucket.length);
    const minGas = bucket.reduce(
      (m, r) => (r.gasUsed < m ? r.gasUsed : m),
      bucket[0].gasUsed,
    );
    const maxGas = bucket.reduce(
      (m, r) => (r.gasUsed > m ? r.gasUsed : m),
      bucket[0].gasUsed,
    );
    log.info(
      `  ${op.padEnd(20)} | ${phase.padEnd(12)} | ${avgMs.toString().padStart(6)} | ` +
        `${avgGas.toLocaleString().padStart(14)} | ${minGas.toLocaleString().padStart(14)} | ` +
        maxGas.toLocaleString(),
    );
  }
  log.info(
    "══════════════════════════════════════════════════════════════════════════",
  );

  if (ethereumEnv) await ethereumEnv.tearDown();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

describe("PolicyRegistry — full proposal lifecycle (50 runs)", () => {
  it(
    "addParameter — 50 runs",
    async () => {
      await benchmarkOperation(
        "addParameter",
        "add parameter",
        async (run) => ({
          actions: [
            {
              target: dao.addresses.policyRegistry,
              calldata: encodeAddParameter(
                web3,
                `benchParam_${run}`,
                BigInt(run),
              ),
            },
          ],
          description: `Proposal: add parameter "benchParam_${run}" = ${run} [run ${run}]`,
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "setParameter — 50 runs",
    async () => {
      const key = "satp.session.lockExpirationTime";
      await benchmarkOperation("setParameter", `set "${key}"`, async (run) => ({
        actions: [
          {
            target: dao.addresses.policyRegistry,
            calldata: encodeSetParameter(web3, key, BigInt(run + 60)),
          },
        ],
        description: `Proposal: set "${key}" to ${run + 60} [run ${run}]`,
      }));
    },
    TIMEOUT,
  );

  it(
    "removeParameter — 50 runs",
    async () => {
      await benchmarkOperation(
        "removeParameter",
        "removeParameter",
        async (run) => ({
          actions: [
            {
              target: dao.addresses.policyRegistry,
              calldata: encodeAddParameter(
                web3,
                `removeTarget_${run}`,
                BigInt(run),
              ),
            },
            {
              target: dao.addresses.policyRegistry,
              calldata: encodeRemoveParameter(web3, `removeTarget_${run}`),
            },
          ],
          description: `Proposal: add+remove "removeTarget_${run}" [run ${run}]`,
        }),
      );
    },
    TIMEOUT,
  );
});

describe("GatewayRegistry — full proposal lifecycle (50 runs)", () => {
  it(
    "registerOrganization — 50 runs",
    async () => {
      await benchmarkOperation(
        "registerOrganization",
        "register new org",
        async (run) => {
          const newOrgAccount = await ethereumEnv.ledger.createEthTestAccount();
          return {
            actions: [
              {
                target: dao.addresses.token,
                calldata: encodeTransfer(
                  web3,
                  newOrgAccount.address,
                  DAO_CONFIG.tokenomics.defaultMemberTokens,
                ),
              },
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRegisterOrganization(
                  web3,
                  newOrgAccount.address,
                  `Benchmark Org ${run}`,
                  1000,
                ),
              },
            ],
            description: `Proposal: register org ${newOrgAccount.address} [run ${run}]`,
          };
        },
      );
    },
    TIMEOUT,
  );

  it(
    "setOrganizationStatus — 50 runs",
    async () => {
      await benchmarkOperation(
        "setOrganizationStatus",
        `setOrgStatus ORG_A`,
        async (run) => {
          const status = run % 2 === 1 ? OrgStatus.Suspended : OrgStatus.Active;
          return {
            actions: [
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeSetOrganizationStatus(
                  web3,
                  ORG_A.address,
                  status,
                  `Benchmark run ${run}: set org status`,
                ),
              },
            ],
            description: `Proposal: set ORG_A status to ${status} [run ${run}]`,
          };
        },
      );
    },
    TIMEOUT,
  );

  it(
    "removeOrganization (reclaim tokens) — 50 runs",
    async () => {
      await benchmarkOperation(
        "removeOrganization",
        "remove+reclaim org",
        async (run) => {
          const freshOrg = await ethereumEnv.ledger.createEthTestAccount();
          return {
            setupActions: [
              {
                target: dao.addresses.token,
                calldata: encodeTransfer(
                  web3,
                  freshOrg.address,
                  DAO_CONFIG.tokenomics.defaultMemberTokens,
                ),
              },
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRegisterOrganization(
                  web3,
                  freshOrg.address,
                  `Temp Org Reclaim ${run}`,
                  1000,
                ),
              },
            ],
            setupDescription: `Setup: register org for reclaim run ${run}`,
            actions: [
              {
                target: dao.addresses.token,
                calldata: encodeReclaimTokensToAddress(
                  web3,
                  freshOrg.address,
                  dao.addresses.timelock,
                ),
              },
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRemoveOrganization(
                  web3,
                  freshOrg.address,
                  `Benchmark: remove org run ${run}`,
                ),
              },
            ],
            description: `Proposal: remove+reclaim org ${freshOrg.address} [run ${run}]`,
          };
        },
      );
    },
    TIMEOUT,
  );

  it(
    "removeOrganization (burn tokens) — 50 runs",
    async () => {
      await benchmarkOperation(
        "removeOrganization",
        "remove+burn org",
        async (run) => {
          const freshOrg = await ethereumEnv.ledger.createEthTestAccount();
          return {
            setupActions: [
              {
                target: dao.addresses.token,
                calldata: encodeTransfer(
                  web3,
                  freshOrg.address,
                  DAO_CONFIG.tokenomics.defaultMemberTokens,
                ),
              },
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRegisterOrganization(
                  web3,
                  freshOrg.address,
                  `Temp Org Burn ${run}`,
                  1000,
                ),
              },
            ],
            setupDescription: `Setup: register org for burn run ${run}`,
            actions: [
              {
                target: dao.addresses.token,
                calldata: encodeBurnAllTokensFromAccount(
                  web3,
                  freshOrg.address,
                ),
              },
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRemoveOrganization(
                  web3,
                  freshOrg.address,
                  `Benchmark: remove+burn org run ${run}`,
                ),
              },
            ],
            description: `Proposal: remove+burn org ${freshOrg.address} [run ${run}]`,
          };
        },
      );
    },
    TIMEOUT,
  );

  it(
    "registerGateway — 50 runs",
    async () => {
      await benchmarkOperation(
        "registerGateway",
        "register new gateway",
        async (run) => {
          const newGwAccount = await ethereumEnv.ledger.createEthTestAccount();
          return {
            actions: [
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRegisterGateway(
                  web3,
                  newGwAccount.address,
                  ORG_A.address,
                  `benchmark-gateway-${run}`,
                ),
              },
            ],
            description: `Proposal: register gateway ${newGwAccount.address} [run ${run}]`,
          };
        },
      );
    },
    TIMEOUT,
  );

  it(
    "setGatewayStatus — 50 runs",
    async () => {
      await benchmarkOperation(
        "setGatewayStatus",
        "setGatewayStatus",
        async (run) => {
          const freshGw = await ethereumEnv.ledger.createEthTestAccount();
          return {
            setupActions: [
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRegisterGateway(
                  web3,
                  freshGw.address,
                  ORG_A.address,
                  `benchmark-gw-status-${run}`,
                ),
              },
            ],
            setupDescription: `Setup: register gateway for status run ${run}`,
            actions: [
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeSetGatewayStatus(
                  web3,
                  freshGw.address,
                  GatewayStatus.Suspended,
                  `Benchmark: suspend gateway run ${run}`,
                ),
              },
            ],
            description: `Proposal: suspend gateway ${freshGw.address} [run ${run}]`,
          };
        },
      );
    },
    TIMEOUT,
  );

  it.only(
    "removeGateway — 50 runs",
    async () => {
      await benchmarkOperation(
        "removeGateway",
        "remove gateway",
        async (run) => {
          const keypair = Secp256k1Keys.generateKeyPairsBuffer();
          const freshGwPublicKey = bufArray2HexStr(keypair.publicKey);
          return {
            setupActions: [
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRegisterGateway(
                  web3,
                  freshGwPublicKey,
                  ORG_A.address,
                  `benchmark-gw-remove-${run}`,
                ),
              },
            ],
            setupDescription: `Setup: register gateway for remove run ${run}`,
            actions: [
              {
                target: dao.addresses.gatewayRegistry,
                calldata: encodeRemoveGateway(
                  web3,
                  freshGwPublicKey,
                  `Benchmark: remove gateway run ${run}`,
                ),
              },
            ],
            description: `Proposal: remove gateway ${freshGwPublicKey.slice(0, 12)}… [run ${run}]`,
          };
        },
      );
    },
    TIMEOUT,
  );
});
