import "jest-extended";
import {
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import {
  EthereumTestEnvironment,
  SupportedContractTypes as SupportedEthereumContractTypes,
} from "../../../environments/ethereum-test-environment";
import {
  DeployDaoResult,
  createOrganization,
  addProtocolParameter,
  LabeledReceipt,
  deployContract,
  TOKEN_CONTRACT_NAME,
  GATEWAY_REGISTRY_CONTRACT_NAME,
  POLICY_REGISTRY_CONTRACT_NAME,
  deployContractsOnly,
  registerGateway,
} from "../utils/governance-test-utils";
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import {
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { buildProfileConfig, DaoProfile } from "../governance-dao-profiles";
import * as fs from "fs";
import * as path from "path";
import TokenContract from "../../../../solidity/generated/Token.sol/Token.json";
import GatewayRegistryContract from "../../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import PolicyRegistryContract from "../../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import { bufArray2HexStr } from "../../../../../main/typescript";

const TIMEOUT = 600_000;
const RUNS = 50;
const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - DAO Deployment Benchmarks",
});

interface BenchmarkResult {
  label: string;
  averageTimeMs: number;
  averageGasUsed: string;
  runs: number;
}

interface RunData {
  runIndex: number;
  timeMs: number;
  gasUsed: string;
}

const results: BenchmarkResult[] = [];
let perRunDir: string;

let ethereumEnv: EthereumTestEnvironment;

async function savePerRunData(label: string, runs: RunData[]) {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(perRunDir, `per-run-${safeLabel}.json`);
  const payload = {
    testLabel: label,
    totalRuns: RUNS,
    runs,
  };
  await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2));
  log.info(`Per-run data saved to ${filePath}`);
}

beforeAll(async () => {
  perRunDir = path.join(
    __dirname,
    "evaluation-results",
    "fixed-costs-deployment-per-run-data",
  );
  await fs.promises.mkdir(perRunDir, { recursive: true });

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
  log.info("Ethereum ledger started for deployment benchmarks");
  await ethereumEnv.deployAndSetupContracts(1);
}, TIMEOUT);

afterAll(async () => {
  const outputDir = path.join(__dirname, "evaluation-results");
  try {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `fixed-costs-deployment--${RUNS}runs-${timestamp}.json`;
    const outputPath = path.join(outputDir, filename);

    const payload = {
      runAt: new Date().toISOString(),
      description:
        "Average DAO deployment costs and per-operation variable costs (50 runs each)",
      environment: "Local Ethereum test network (Hardhat)",
      runsPerSample: RUNS,
      benchmarks: results,
    };

    await fs.promises.writeFile(outputPath, JSON.stringify(payload, null, 2));
    log.info(`Summary saved to ${outputPath}`);
  } catch (err) {
    log.error(`Failed to save benchmark results: ${err}`);
  }

  log.info(
    "══════════════════════════════════════════════════════════════════════════════════",
  );
  log.info("  AVERAGE DAO DEPLOYMENT COSTS (50 runs each)");
  log.info(
    "══════════════════════════════════════════════════════════════════════════════════",
  );
  log.info(
    "Label                                                    | Avg Time (ms) | Avg Gas Used",
  );
  results.forEach((r) =>
    log.info(
      `  ${r.label.padEnd(55)} | ${r.averageTimeMs.toFixed(1).padStart(10)} | ${r.averageGasUsed}`,
    ),
  );
  log.info(
    "══════════════════════════════════════════════════════════════════════════════════",
  );

  if (ethereumEnv) await ethereumEnv.tearDown();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

describe("DAO Deployment Cost - All Configurations", () => {
  for (let p = 1; p <= 6; p++) {
    const profile = p as DaoProfile;
    const config = buildProfileConfig(profile);
    const timelock = config.timelock.enabled;
    const votingSystem = config.governance.votingSystem;

    it(`Profile ${p}: Timelock=${timelock}, Voting=${votingSystem}`, async () => {
      let totalTimeSum = 0;
      let totalGasSum = 0n;
      const runResults: RunData[] = [];

      for (let i = 0; i < RUNS; i++) {
        const t0 = Date.now();
        const daoResult: DeployDaoResult = await deployContractsOnly(
          ethereumEnv,
          config,
        );
        const t1 = Date.now();

        const gas = daoResult.receipts.reduce(
          (acc, { receipt }) => acc + BigInt(receipt.gasUsed ?? 0),
          BigInt(0),
        );

        totalTimeSum += t1 - t0;
        totalGasSum += gas;

        runResults.push({
          runIndex: i,
          timeMs: t1 - t0,
          gasUsed: gas.toString(),
        });
      }

      const avgTime = totalTimeSum / RUNS;
      const avgGas = totalGasSum / BigInt(RUNS);
      const label = `Profile ${p} (Timelock ${timelock}, ${votingSystem})`;
      results.push({
        label,
        averageTimeMs: avgTime,
        averageGasUsed: avgGas.toString(),
        runs: RUNS,
      });

      await savePerRunData(label, runResults);

      log.info(
        `Profile ${p} avg — ${avgTime.toFixed(1)} ms, ${avgGas.toString()} gas (${RUNS} runs)`,
      );
    });
  }
});

describe("Isolated Operations DURING STAGE: DAO CREATION", () => {
  let deployerCredentials: Web3SigningCredentialPrivateKeyHex;
  let tokenAddress: string;
  let gatewayRegistryAddress: string;
  let policyRegistryAddress: string;

  beforeAll(async () => {
    const account = await ethereumEnv.ledger.createEthTestAccount();
    deployerCredentials = {
      ethAccount: account.address,
      secret: account.privateKey,
      type: Web3SigningCredentialType.PrivateKeyHex,
    };

    const tokenResult = await deployContract(
      ethereumEnv,
      TOKEN_CONTRACT_NAME,
      TokenContract.abi,
      TokenContract.bytecode.object,
      deployerCredentials,
      ["GovernanceToken", "GOV", "1000000", deployerCredentials.ethAccount],
    );
    tokenAddress = tokenResult.address;

    const registryResult = await deployContract(
      ethereumEnv,
      GATEWAY_REGISTRY_CONTRACT_NAME,
      GatewayRegistryContract.abi,
      GatewayRegistryContract.bytecode.object,
      deployerCredentials,
      [deployerCredentials.ethAccount],
    );
    gatewayRegistryAddress = registryResult.address;

    const policyResult = await deployContract(
      ethereumEnv,
      POLICY_REGISTRY_CONTRACT_NAME,
      PolicyRegistryContract.abi,
      PolicyRegistryContract.bytecode.object,
      deployerCredentials,
      [deployerCredentials.ethAccount],
    );
    policyRegistryAddress = policyResult.address;

    log.info("Isolated environment ready: deployer owns Token/Registries.");
  });

  it("should add a protocol parameter (STAGE:DAO CREATION)", async () => {
    let totalTimeSum = 0;
    let totalGasSum = 0n;
    const runResults: RunData[] = [];

    for (let i = 0; i < RUNS; i++) {
      const param = { key: `benchmark_${i}`, value: "42" };

      const t0 = Date.now();
      const receipt: LabeledReceipt = await addProtocolParameter(
        ethereumEnv,
        deployerCredentials,
        policyRegistryAddress,
        param,
      );
      const t1 = Date.now();

      const gas = BigInt(receipt.receipt.gasUsed ?? 0);
      totalTimeSum += t1 - t0;
      totalGasSum += gas;

      runResults.push({
        runIndex: i,
        timeMs: t1 - t0,
        gasUsed: gas.toString(),
      });
    }

    const avgTime = totalTimeSum / RUNS;
    const avgGas = totalGasSum / BigInt(RUNS);
    const label = "Add one protocol parameter";
    results.push({
      label,
      averageTimeMs: avgTime,
      averageGasUsed: avgGas.toString(),
      runs: RUNS,
    });

    await savePerRunData(label, runResults);

    log.info(
      `Add parameter avg — ${avgTime.toFixed(1)} ms, ${avgGas.toString()} gas (${RUNS} runs)`,
    );
  });

  it("should register an organization (STAGE:DAO CREATION)", async () => {
    let totalTimeSum = 0;
    let totalGasSum = 0n;
    const runResults: RunData[] = [];

    for (let i = 0; i < RUNS; i++) {
      const orgAccount = await ethereumEnv.ledger.createEthTestAccount();
      const org = {
        address: orgAccount.address,
        name: `BenchmarkOrg_${i}`,
        gateways: [],
        reputation: 1000,
      };

      const t0 = Date.now();
      const receipts = await createOrganization(
        ethereumEnv,
        deployerCredentials,
        tokenAddress,
        gatewayRegistryAddress,
        1000n,
        org,
      );
      const t1 = Date.now();

      const iterationGas = receipts.reduce(
        (acc, { receipt }) => acc + BigInt(receipt.gasUsed ?? 0),
        BigInt(0),
      );

      totalTimeSum += t1 - t0;
      totalGasSum += iterationGas;

      runResults.push({
        runIndex: i,
        timeMs: t1 - t0,
        gasUsed: iterationGas.toString(),
      });
    }

    const avgTime = totalTimeSum / RUNS;
    const avgGas = totalGasSum / BigInt(RUNS);
    const label = "Register one organization";
    results.push({
      label,
      averageTimeMs: avgTime,
      averageGasUsed: avgGas.toString(),
      runs: RUNS,
    });

    await savePerRunData(label, runResults);

    log.info(
      `Register org avg — ${avgTime.toFixed(1)} ms, ${avgGas.toString()} gas (${RUNS} runs)`,
    );
  });

  it("should register a gateway directly (STAGE:DAO CREATION)", async () => {
    const orgAccount = await ethereumEnv.ledger.createEthTestAccount();
    const org = {
      address: orgAccount.address,
      name: "GatewayBenchmarkOrg",
      gateways: [],
      reputation: 1000,
    };
    await createOrganization(
      ethereumEnv,
      deployerCredentials,
      tokenAddress,
      gatewayRegistryAddress,
      1000n,
      org,
    );
    const gatewayOrgAddress = org.address;

    let totalTimeSum = 0;
    let totalGasSum = 0n;
    const runResults: RunData[] = [];

    for (let i = 0; i < RUNS; i++) {
      const keypairA = Secp256k1Keys.generateKeyPairsBuffer();
      const gatewayPublicKey = bufArray2HexStr(keypairA.publicKey);
      const gatewayName = `benchmark-gateway_${i}`;

      const t0 = Date.now();
      const receipt: LabeledReceipt = await registerGateway(
        ethereumEnv,
        deployerCredentials,
        gatewayRegistryAddress,
        { publicKey: gatewayPublicKey, name: gatewayName },
        gatewayOrgAddress,
      );
      const t1 = Date.now();

      const gas = BigInt(receipt.receipt.gasUsed ?? 0);
      totalTimeSum += t1 - t0;
      totalGasSum += gas;

      runResults.push({
        runIndex: i,
        timeMs: t1 - t0,
        gasUsed: gas.toString(),
      });
    }

    const avgTime = totalTimeSum / RUNS;
    const avgGas = totalGasSum / BigInt(RUNS);
    const label = "Register one gateway directly";
    results.push({
      label,
      averageTimeMs: avgTime,
      averageGasUsed: avgGas.toString(),
      runs: RUNS,
    });

    await savePerRunData(label, runResults);

    log.info(
      `Register gateway avg — ${avgTime.toFixed(1)} ms, ${avgGas.toString()} gas (${RUNS} runs)`,
    );
  });
});
