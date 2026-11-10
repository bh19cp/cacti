import "jest-extended";
import Web3 from "web3";
import type { EventLog } from "web3";
import { LogLevelDesc, Secp256k1Keys } from "@hyperledger/cactus-common";
import { pruneDockerContainersIfGithubAction } from "@hyperledger/cactus-test-tooling";
import {
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { EthereumTestEnvironment } from "../../../test-utils";
import { SupportedContractTypes as SupportedEthereumContractTypes } from "../../../environments/ethereum-test-environment";
import {
  deployDao,
  DeployDaoResult,
  delegateOrganizationTokens,
  runSuccessfulVoting,
  GatewayStatus,
} from "../utils/governance-test-utils";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { GovernanceConfig } from "../governance-config/governance-config";
import {
  encodeAddParameter,
  encodeSetParameter,
  encodeRemoveParameter,
  encodeSetGatewayStatus,
} from "../utils/governance-encode-utils";
import { bufArray2HexStr } from "../../../../../main/typescript";
import GovernanceWithTimelockContract from "../../../../solidity/generated/GovernanceWithTImelock.sol/GovernanceWithTimelock.json";
import PolicyRegistryContract from "../../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";

const TIMEOUT = 12_000_000;
const logLevel: LogLevelDesc = "INFO";
const LOCK_KEY = "satp.session.lockExpirationTime";

let ethereumEnv: EthereumTestEnvironment;
let web3: InstanceType<typeof Web3>;
let orgCreds: Web3SigningCredentialPrivateKeyHex[] = [];
let orgAddresses: string[] = [];
let gatewayKeys: string[] = [];

const normKey = (k: string) =>
  (k.startsWith("0x") ? k : "0x" + k).toLowerCase();

const onlyLogs = (xs: (string | EventLog)[]): EventLog[] =>
  xs.filter((x): x is EventLog => typeof x !== "string");

const asBig = (v: unknown): bigint => BigInt(v as any);

function buildConfig(timelockEnabled: boolean): GovernanceConfig {
  return {
    name: "GatewayDAO",
    tokenomics: {
      name: "GovernanceToken",
      symbol: "GOV",
      supply: 1_000_000,
      defaultMemberTokens: 1000,
    },
    organizations: orgAddresses.map((address, i) => ({
      address,
      name: `Organization ${i}`,
      gateways: [{ publicKey: gatewayKeys[i], name: `Gateway ${i}` }],
      reputation: 1000,
    })),
    governance: {
      votingSystem: "token-based",
      votingDelay: 1,
      votingPeriod: 5,
      proposalThreshold: 1,
      quorumFraction: 0,
    },
    timelock: { enabled: timelockEnabled, minDelay: 0 },
    protocolParameters: [
      { key: "satp.version", value: "v02" },
      { key: LOCK_KEY, value: "34" },
      { key: "signingAlgorithm", value: "ECDSA" },
      { key: "claimFormat", value: "2" },
    ],
  };
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
  await ethereumEnv.deployAndSetupContracts(1);
  web3 = (ethereumEnv.connector as any).web3;

  const accs = [
    await ethereumEnv.ledger.createEthTestAccount(),
    await ethereumEnv.ledger.createEthTestAccount(),
    await ethereumEnv.ledger.createEthTestAccount(),
  ];
  orgCreds = accs.map((a) => ({
    ethAccount: a.address,
    secret: a.privateKey,
    type: Web3SigningCredentialType.PrivateKeyHex,
  }));
  orgAddresses = accs.map((a) => a.address);
  gatewayKeys = accs.map(() =>
    bufArray2HexStr(Secp256k1Keys.generateKeyPairsBuffer().publicKey),
  );
}, TIMEOUT);

afterAll(async () => {
  if (ethereumEnv) await ethereumEnv.tearDown();
  await pruneDockerContainersIfGithubAction({ logLevel });
}, TIMEOUT);

describe.each([
  { label: "with timelock", timelockEnabled: true },
  { label: "without timelock", timelockEnabled: false },
])("R5 — traceability ($label)", ({ label, timelockEnabled }) => {
  let dao: DeployDaoResult;
  let governor: any;
  let policy: any;
  let gatewayRegistry: any;
  let counter = 0;

  beforeAll(async () => {
    dao = await deployDao(ethereumEnv, buildConfig(timelockEnabled));
    await delegateOrganizationTokens(
      ethereumEnv,
      dao.addresses.token,
      orgCreds,
    );

    governor = new web3.eth.Contract(
      GovernanceWithTimelockContract.abi as any,
      dao.addresses.governor,
    );
    policy = new web3.eth.Contract(
      PolicyRegistryContract.abi as any,
      dao.addresses.policyRegistry,
    );
    gatewayRegistry = new web3.eth.Contract(
      GatewayRegistryContract.abi as any,
      dao.addresses.gatewayRegistry,
    );
  }, TIMEOUT);

  async function execute(
    target: string,
    calldata: string,
    what: string,
  ): Promise<{
    proposalId: string;
    txHash: string;
    blockNumber: bigint | number;
    description: string;
  }> {
    const description = `R5 (${label}) #${++counter}: ${what}`;
    const { proposalId, executeTxHash } = await runSuccessfulVoting({
      ethereumEnv,
      web3,
      governorAddress: dao.addresses.governor,
      timelockAddress: timelockEnabled ? dao.addresses.timelock : undefined,
      targetAddress: target,
      calldata,
      description,
      organizationsCredentials: orgCreds,
      deployerCredentials: orgCreds[0],
    });
    const receipt = await web3.eth.getTransactionReceipt(executeTxHash);
    return {
      proposalId,
      txHash: executeTxHash,
      blockNumber: receipt.blockNumber,
      description,
    };
  }

  async function eventsInTx(
    contract: any,
    name: string,
    blockNumber: bigint | number,
    txHash: string,
  ): Promise<EventLog[]> {
    const logs = onlyLogs(
      await contract.getPastEvents(name, {
        fromBlock: blockNumber,
        toBlock: blockNumber,
      }),
    );
    return logs.filter(
      (e) => e.transactionHash?.toLowerCase() === txHash.toLowerCase(),
    );
  }

  async function expectGovernorTrace(
    t: Awaited<ReturnType<typeof execute>>,
    target: string,
    calldata: string,
  ) {
    const executed = await eventsInTx(
      governor,
      "ProposalExecuted",
      t.blockNumber,
      t.txHash,
    );
    expect(executed).toHaveLength(1);
    expect(asBig((executed[0].returnValues as any).proposalId)).toBe(
      BigInt(t.proposalId),
    );

    const expectedId = await governor.methods
      .hashProposal(
        [target],
        [0],
        [calldata],
        web3.utils.keccak256(t.description),
      )
      .call();
    expect(BigInt(expectedId as unknown as string)).toBe(BigInt(t.proposalId));
  }

  it(
    "setParameter: ProposalExecuted and ParameterUpdated share one transaction",
    async () => {
      const previous = asBig(await policy.methods.getValue(LOCK_KEY).call());
      const newValue = 900_000n;
      const calldata = encodeSetParameter(web3, LOCK_KEY, newValue);
      const t = await execute(
        dao.addresses.policyRegistry,
        calldata,
        "set lock expiration",
      );

      await expectGovernorTrace(t, dao.addresses.policyRegistry, calldata);

      const upd = await eventsInTx(
        policy,
        "ParameterUpdated",
        t.blockNumber,
        t.txHash,
      );
      expect(upd).toHaveLength(1);
      const rv = upd[0].returnValues as any;
      expect(rv.key).toBe(LOCK_KEY);
      expect(asBig(rv.oldValue)).toBe(previous);
      expect(asBig(rv.newValue)).toBe(newValue);
      expect(asBig(rv.timestamp)).toBeGreaterThan(0n);

      expect(asBig(await policy.methods.getValue(LOCK_KEY).call())).toBe(
        newValue,
      );
    },
    TIMEOUT,
  );

  it(
    "addParameter: ParameterAdded is traceable to the proposal",
    async () => {
      const key = `r5.added.${label.replace(/\s/g, "-")}`;
      const calldata = encodeAddParameter(web3, key, 7n);
      const t = await execute(
        dao.addresses.policyRegistry,
        calldata,
        "add parameter",
      );

      await expectGovernorTrace(t, dao.addresses.policyRegistry, calldata);

      const added = await eventsInTx(
        policy,
        "ParameterAdded",
        t.blockNumber,
        t.txHash,
      );
      expect(added).toHaveLength(1);
      const rv = added[0].returnValues as any;
      expect(rv.key).toBe(key);
      expect(asBig(rv.value)).toBe(7n);
      expect(asBig(await policy.methods.getValue(key).call())).toBe(7n);
    },
    TIMEOUT,
  );

  it(
    "removeParameter: ParameterRemoved is traceable to the proposal",
    async () => {
      const key = `r5.removed.${label.replace(/\s/g, "-")}`;
      await execute(
        dao.addresses.policyRegistry,
        encodeAddParameter(web3, key, 1n),
        "add parameter to be removed",
      );
      expect(await policy.methods.parameterExists(key).call()).toBe(true);

      const calldata = encodeRemoveParameter(web3, key);
      const t = await execute(
        dao.addresses.policyRegistry,
        calldata,
        "remove parameter",
      );

      await expectGovernorTrace(t, dao.addresses.policyRegistry, calldata);

      const removed = await eventsInTx(
        policy,
        "ParameterRemoved",
        t.blockNumber,
        t.txHash,
      );
      expect(removed).toHaveLength(1);
      expect((removed[0].returnValues as any).key).toBe(key);
      expect(await policy.methods.parameterExists(key).call()).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "setGatewayStatus: a Gateway Registry change is traceable to the proposal",
    async () => {
      const gwKey = normKey(gatewayKeys[2]);
      expect(await gatewayRegistry.methods.isGatewayActive(gwKey).call()).toBe(
        true,
      );

      const calldata = encodeSetGatewayStatus(
        web3,
        gwKey,
        GatewayStatus.Suspended,
        "R5: suspend",
      );
      const t = await execute(
        dao.addresses.gatewayRegistry,
        calldata,
        "suspend gateway",
      );

      await expectGovernorTrace(t, dao.addresses.gatewayRegistry, calldata);

      const registryEvents = onlyLogs(
        await gatewayRegistry.getPastEvents("allEvents", {
          fromBlock: t.blockNumber,
          toBlock: t.blockNumber,
        }),
      ).filter(
        (e) => e.transactionHash?.toLowerCase() === t.txHash.toLowerCase(),
      );
      expect(registryEvents.length).toBeGreaterThan(0);

      expect(await gatewayRegistry.methods.isGatewayActive(gwKey).call()).toBe(
        false,
      );
    },
    TIMEOUT,
  );

  it(
    "the proposal id is bound to its content (tampered content gives a different id)",
    async () => {
      const calldata = encodeSetParameter(web3, LOCK_KEY, 123_456n);
      const t = await execute(
        dao.addresses.policyRegistry,
        calldata,
        "binding check",
      );
      const descHash = web3.utils.keccak256(t.description);

      const hash = async (target: string, data: string, dHash: string) =>
        BigInt(
          (await governor.methods
            .hashProposal([target], [0], [data], dHash)
            .call()) as unknown as string,
        );

      const genuine = await hash(
        dao.addresses.policyRegistry,
        calldata,
        descHash,
      );
      expect(genuine).toBe(BigInt(t.proposalId));

      expect(
        await hash(
          dao.addresses.policyRegistry,
          encodeSetParameter(web3, LOCK_KEY, 123_457n),
          descHash,
        ),
      ).not.toBe(genuine);
      expect(
        await hash(dao.addresses.gatewayRegistry, calldata, descHash),
      ).not.toBe(genuine);
      expect(
        await hash(
          dao.addresses.policyRegistry,
          calldata,
          web3.utils.keccak256("another description"),
        ),
      ).not.toBe(genuine);
    },
    TIMEOUT,
  );
});
