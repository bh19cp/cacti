import Web3 from "web3";
import { v4 as uuidV4 } from "uuid";
import { knex, Knex } from "knex";
import path from "path";
import {
  LogLevel,
  LogLevelDesc,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { LedgerType, PluginImportType } from "@hyperledger/cactus-core-api";
import {
  Web3SigningCredentialPrivateKeyHex,
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import {
  BesuTestEnvironment,
  EthereumTestEnvironment,
} from "../../../test-utils";
import { SupportedContractTypes as EthTypes } from "../../../environments/ethereum-test-environment";
import { SupportedContractTypes as BesuTypes } from "../../../environments/besu-test-environment";
import { GovernanceConfig } from "../governance-config/governance-config";
import {
  delegateOrganizationTokens,
  deployDao,
  DeployDaoResult,
} from "../utils/governance-test-utils";
import { bufArray2HexStr } from "../../../../../main/typescript/utils/gateway-utils";
import {
  Address,
  GatewayIdentity,
  MonitorService,
  PluginFactorySATPGateway,
  SATPGateway,
  SATPGatewayConfig,
  ClaimFormat,
} from "../../../../../main/typescript";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../../../../main/typescript/core/constants";
import { GovernanceManager } from "../../../../../main/typescript/governance/governance-manager";
import { OracleAbstract } from "../../../../../main/typescript/cross-chain-mechanisms/oracle/oracle-abstract";
import { OracleFactory } from "../../../../../main/typescript/cross-chain-mechanisms/oracle/oracle-factory";
import { createMigrationSource } from "../../../../../main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "../../../../../main/typescript/database/knexfile";
import { knexRemoteInstance } from "../../../../../main/typescript/database/knexfile-remote";
import { SupportedSigningAlgorithms } from "../../../../../main/typescript/core/types";
import { writeConfigFromTemplate } from "./config";
import PolicyRegistryContract from "../../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";

export const ETH_NETWORK_ID_2 = "EthereumLedgerTestNetwork-2";
export const GW_NAMES = ["A", "B", "C"] as const;
export type GwName = (typeof GW_NAMES)[number];
// A = Besu gateway, B = Ethereum gateway, C = Ethereum gateway on network 2
export const GW_LEDGER: Record<GwName, string> = {
  A: "Besu",
  B: "Ethereum",
  C: "Ethereum-2",
};

export interface DaoAbis {
  gatewayRegistry: any[];
  policyRegistry: any[];
}

export interface DemoEnv {
  lite: boolean;
  logLevel: LogLevelDesc;
  monitorService: MonitorService;
  ethereumEnv: EthereumTestEnvironment;
  besuEnv?: BesuTestEnvironment;
  web3: InstanceType<typeof Web3>;
  orgs: Web3SigningCredentialPrivateKeyHex[];
  config: GovernanceConfig;
  keyPairs: Record<GwName, any>;
  gwKeys: Record<GwName, string>;
  // set by deployEnv()
  dao?: DeployDaoResult;
  abis?: DaoAbis;
  oracle?: OracleAbstract;
  gms?: Record<GwName, GovernanceManager>;
  gateways?: Record<GwName, SATPGateway>;
  toClose: Array<() => Promise<unknown>>;
  teardown: () => Promise<void>;
}

export type DeployedEnv = DemoEnv & {
  dao: DeployDaoResult;
  abis: DaoAbis;
  oracle: OracleAbstract;
};

export async function bootEnv(opts: { lite: boolean }): Promise<DemoEnv> {
  const logLevel = (process.env.DEMO_LOG ?? "WARN") as LogLevelDesc;
  process.env.BESU_LOGGING ??= "INFO";
  const monitorService = MonitorService.createOrGetMonitorService({
    enabled: false,
  });
  const toClose: Array<() => Promise<unknown>> = [];

  const ethereumEnv = await EthereumTestEnvironment.setupTestEnvironment(
    { logLevel },
    [
      { assetType: EthTypes.FUNGIBLE, contractName: "SATPContract" },
      { assetType: EthTypes.NONFUNGIBLE, contractName: "SATPNFTContract" },
    ],
  );
  await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  toClose.push(() => ethereumEnv.tearDown());
  const web3 = (ethereumEnv.connector as any).web3;

  const accounts: Array<{ address: string; privateKey: string }> = [];
  for (let i = 0; i < 3; i++)
    accounts.push(await ethereumEnv.ledger.createEthTestAccount());
  const orgs: Web3SigningCredentialPrivateKeyHex[] = accounts.map((a) => ({
    ethAccount: a.address,
    secret: a.privateKey,
    type: Web3SigningCredentialType.PrivateKeyHex,
  }));
  const kps = GW_NAMES.map(() => Secp256k1Keys.generateKeyPairsBuffer());
  const keyPairs = { A: kps[0], B: kps[1], C: kps[2] };
  const gwKeys = {
    A: bufArray2HexStr(kps[0].publicKey),
    B: bufArray2HexStr(kps[1].publicKey),
    C: bufArray2HexStr(kps[2].publicKey),
  };

  const config = writeConfigFromTemplate({
    ...Object.fromEntries(
      GW_NAMES.map((n, i) => [`ORG_${n}_ADDRESS`, accounts[i].address]),
    ),
    ...Object.fromEntries(
      GW_NAMES.map((n) => [`GATEWAY_${n}_PUBLIC_KEY`, "0x" + gwKeys[n]]),
    ),
  });

  const env: DemoEnv = {
    lite: opts.lite,
    logLevel,
    monitorService,
    ethereumEnv,
    web3,
    orgs,
    config,
    keyPairs,
    gwKeys,
    toClose,
    teardown: async () => {
      for (const gm of Object.values(env.gms ?? {}))
        await gm.stop().catch(() => {});
      for (const g of Object.values(env.gateways ?? {}))
        await g.shutdown().catch(() => {});
      for (const f of [...toClose].reverse()) await f().catch(() => {});
      toClose.length = 0;
    },
  };
  if (opts.lite) return env;

  const besuEnv = await BesuTestEnvironment.setupTestEnvironment({ logLevel }, [
    { assetType: BesuTypes.FUNGIBLE, contractName: "SATPContract" },
    { assetType: BesuTypes.NONFUNGIBLE, contractName: "SATPNFTContract" },
  ]);
  await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  toClose.push(() => besuEnv.tearDown());
  env.besuEnv = besuEnv;
  return env;
}

export async function deployEnv(env: DemoEnv): Promise<DeployedEnv> {
  if (env.dao) throw new Error("already deployed");
  const { ethereumEnv, config, monitorService, logLevel, toClose } = env;

  const dao = await deployDao(ethereumEnv, config);
  const abis: DaoAbis = {
    gatewayRegistry: GatewayRegistryContract.abi,
    policyRegistry: PolicyRegistryContract.abi,
  };
  await delegateOrganizationTokens(ethereumEnv, dao.addresses.token, env.orgs);
  env.dao = dao;
  env.abis = abis;
  env.oracle = OracleFactory.create(ethereumEnv.createEthereumConfig(), {
    logLevel,
    monitorService,
  });
  if (env.lite) return env as DeployedEnv;

  const besuEnv = env.besuEnv!;
  const migrationSource = await createMigrationSource();
  const knexLocal: Knex = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource },
  });
  const knexRemote: Knex = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource },
  });
  await knexRemote.migrate.latest();
  toClose.push(
    () => knexLocal.destroy(),
    () => knexRemote.destroy(),
  );

  const mkId = (
    id: string,
    kp: any,
    ports: [number, number, number],
    dlt: { id: string; ledgerType: LedgerType },
  ): GatewayIdentity => ({
    id,
    name: id,
    identificationCredential: {
      signingAlgorithm: SupportedSigningAlgorithms.SECP256K1,
      pubKey: bufArray2HexStr(kp.publicKey),
    },
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: `proof-${id}`,
    address: "http://localhost" as Address,
    gatewayOapiPort: ports[0],
    gatewayServerPort: ports[1],
    gatewayClientPort: ports[2],
    connectedDLTs: [dlt],
  });
  const ids: Record<GwName, GatewayIdentity> = {
    A: mkId("besu-gateway", env.keyPairs.A, [4030, 3030, 3031], {
      id: BesuTestEnvironment.BESU_NETWORK_ID,
      ledgerType: LedgerType.Besu2X,
    }),
    B: mkId("eth-gateway", env.keyPairs.B, [4031, 3032, 3033], {
      id: EthereumTestEnvironment.ETH_NETWORK_ID,
      ledgerType: LedgerType.Ethereum,
    }),
    C: mkId("eth-gateway-2", env.keyPairs.C, [6036, 6037, 6038], {
      id: ETH_NETWORK_ID_2,
      ledgerType: LedgerType.Ethereum,
    }),
  };

  const eth2Cfg = { ...ethereumEnv.createEthereumConfig() };
  eth2Cfg.networkIdentification = {
    ...eth2Cfg.networkIdentification,
    id: ETH_NETWORK_ID_2,
  };
  const ccConfigs: Record<GwName, any> = {
    A: besuEnv.createBesuConfig(),
    B: ethereumEnv.createEthereumConfig(),
    C: eth2Cfg,
  };

  const factory = new PluginFactorySATPGateway({
    pluginImportType: PluginImportType.Local,
  });
  const ontologyPath = path.join(__dirname, "../../../../ontologies");

  const gms = {} as Record<GwName, GovernanceManager>;
  const gateways = {} as Record<GwName, SATPGateway>;
  for (const n of GW_NAMES) {
    const gm = new GovernanceManager({
      logLevel: LogLevel.INFO,
      monitorService,
      oracleConfig: ethereumEnv.createEthereumConfig(),
      policyRegistry: {
        contractAddress: dao.addresses.policyRegistry,
        contractAbi: abis.policyRegistry,
      },
      gatewayRegistry: {
        contractAddress: dao.addresses.gatewayRegistry,
        contractAbi: abis.gatewayRegistry,
      },
    });
    const gw = await factory.create({
      instanceId: uuidV4(),
      logLevel: (process.env.DEMO_GW_LOG ?? "INFO") as LogLevelDesc,
      gid: ids[n],
      keyPair: env.keyPairs[n],
      localRepository: knexLocalInstance.default,
      remoteRepository: knexRemoteInstance.default,
      counterPartyGateways: GW_NAMES.filter((m) => m !== n).map((m) => ids[m]),
      ccConfig: { oracleConfig: [ccConfigs[n]], bridgeConfig: [ccConfigs[n]] },
      pluginRegistry: new PluginRegistry({ plugins: [] }),
      monitorService,
      ontologyPath,
      gatewayComplianceVerifier: gm,
      gatewayPolicyManager: gm,
    } as SATPGatewayConfig);
    await gw.onPluginInit();
    gms[n] = gm;
    gateways[n] = gw;
  }
  for (const n of GW_NAMES) await gateways[n].getOrCreateHttpServer();
  for (const n of GW_NAMES) await gms[n].start(gateways[n]);

  env.gms = gms;
  env.gateways = gateways;
  return env as DeployedEnv;
}
