import { jest } from "@jest/globals";
import { LogLevel } from "@hyperledger/cactus-common";
import { LedgerType } from "@hyperledger/cactus-core-api";
import { GovernanceManager } from "../../../../main/typescript/governance/governance-manager";
import { MonitorService } from "../../../../main/typescript";
import { SATPGateway } from "../../../../main/typescript/plugin-satp-hermes-gateway";
import PolicyRegistryContract from "../../../solidity/generated/PolicyRegistry.sol/PolicyRegistry.json";
import GatewayRegistryContract from "../../../solidity/generated/GatewayRegistry.sol/GatewayRegistry.json";
import { GatewayPolicyConfig } from "../../../../main/typescript/governance/governance-policy-config";

const MOCK_POLICY_REGISTRY_ADDRESS =
  "0xPolicyRegistry000000000000000000000000001";
const MOCK_GATEWAY_REGISTRY_ADDRESS =
  "0xGatewayRegistry00000000000000000000000002";

const MOCK_ORACLE_CONFIG = {
  networkIdentification: {
    ledgerType: LedgerType.Ethereum,
    id: "eth-test-network",
  },
  rpcApiHttpHost: "http://localhost:8545",
  connectorOptions: {},
};

function buildMonitorServiceMock() {
  return {
    enabled: false,
    startSpan: jest.fn().mockReturnValue({
      span: {
        setStatus: jest.fn(),
        recordException: jest.fn(),
        end: jest.fn(),
      },
      context: {},
    }),
  } as unknown as MonitorService;
}

function buildOracleReadEntry(overrides: Record<string, unknown> = {}) {
  return (jest.fn() as any).mockResolvedValue({
    output: overrides.output ?? [],
    ...overrides,
  });
}

function buildGatewayMock(overrides: Partial<SATPGateway> = {}): SATPGateway {
  return {
    applyPolicyConfig: (jest.fn() as any).mockResolvedValue(undefined),
    getOrCreateHttpServer: (jest.fn() as any).mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SATPGateway;
}

jest.mock(
  "../../../../main/typescript/cross-chain-mechanisms/oracle/implementations/oracle-evm",
  () => {
    return {
      OracleEVM: jest.fn().mockImplementation(() => ({
        readEntry: buildOracleReadEntry({ output: [] }),
        subscribeContractEvent: (jest.fn() as any).mockResolvedValue(() => {}),
      })),
    };
  },
);

jest.mock(
  "../../../../main/typescript/cross-chain-mechanisms/oracle/implementations/oracle-besu",
  () => {
    return {
      OracleBesu: jest.fn().mockImplementation(() => ({
        readEntry: buildOracleReadEntry({ output: [] }),
        subscribeContractEvent: (jest.fn() as any).mockResolvedValue(() => {}),
      })),
    };
  },
);

jest.mock("../../../../main/typescript/plugin-satp-hermes-gateway", () => ({
  SATPGateway: jest.fn(),
}));

function buildGovernanceManager(
  monitorService: MonitorService,
): GovernanceManager {
  return new GovernanceManager({
    logLevel: LogLevel.DEBUG,
    monitorService,
    oracleConfig: MOCK_ORACLE_CONFIG as any,
    policyRegistry: {
      contractAddress: MOCK_POLICY_REGISTRY_ADDRESS,
      contractAbi: PolicyRegistryContract.abi,
    },
    gatewayRegistry: {
      contractAddress: MOCK_GATEWAY_REGISTRY_ADDRESS,
      contractAbi: GatewayRegistryContract.abi,
    },
  });
}

describe("GovernanceManager – initialization", () => {
  let monitorService: ReturnType<typeof buildMonitorServiceMock>;

  beforeEach(() => {
    monitorService = buildMonitorServiceMock();
    jest.clearAllMocks();
  });

  describe("constructor", () => {
    it("creates an instance with valid options", () => {
      const gm = buildGovernanceManager(monitorService);
      expect(gm).toBeInstanceOf(GovernanceManager);
    });

    it("throws when options are omitted", () => {
      expect(() => new GovernanceManager(undefined as any)).toThrow();
    });

    it("starts in the stopped state", () => {
      const gm = buildGovernanceManager(monitorService);
      expect(gm.isStarted()).toBe(false);
    });

    it("initialises with an empty handler registry", () => {
      const gm = buildGovernanceManager(monitorService);
      expect(gm.getHandlerIds()).toHaveLength(0);
    });
  });

  describe("handler registry (pre-start)", () => {
    it("registers and retrieves a custom handler", () => {
      const gm = buildGovernanceManager(monitorService);
      const handler = {
        id: "test-handler",
        interestedEvents: ["*"],
        handle: jest.fn(),
      };

      gm.registerHandler(handler as any);
      expect(gm.getHandlerIds()).toContain("test-handler");
    });

    it("throws when the same handler id is registered twice", () => {
      const gm = buildGovernanceManager(monitorService);
      const handler = {
        id: "duplicate-handler",
        interestedEvents: ["*"],
        handle: jest.fn(),
      };

      gm.registerHandler(handler as any);
      expect(() => gm.registerHandler(handler as any)).toThrow(
        /already registered/,
      );
    });

    it("removes a handler by id", () => {
      const gm = buildGovernanceManager(monitorService);
      const handler = {
        id: "removable-handler",
        interestedEvents: ["*"],
        handle: jest.fn(),
      };

      gm.registerHandler(handler as any);
      const removed = gm.unregisterHandler("removable-handler");

      expect(removed).toBe(true);
      expect(gm.getHandlerIds()).not.toContain("removable-handler");
    });

    it("returns false when unregistering a non-existent handler", () => {
      const gm = buildGovernanceManager(monitorService);
      expect(gm.unregisterHandler("ghost-handler")).toBe(false);
    });
  });

  describe("start()", () => {
    it("transitions isStarted() from false to true", async () => {
      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      expect(gm.isStarted()).toBe(false);
      await gm.start(gateway);
      expect(gm.isStarted()).toBe(true);
    });

    it("calls gateway.applyPolicyConfig() with the fetched policy config", async () => {
      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      await gm.start(gateway);

      expect(gateway.applyPolicyConfig).toHaveBeenCalledTimes(1);
      const passedConfig = (gateway.applyPolicyConfig as jest.Mock).mock
        .calls[0][0] as GatewayPolicyConfig;
      expect(passedConfig).toBeDefined();
    });

    it("registers the built-in GatewayStatusHandler and ParameterUpdatedHandler", async () => {
      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      await gm.start(gateway);

      const ids = gm.getHandlerIds();
      expect(ids).toContain("GatewayStatusHandler");
      expect(ids).toContain("ParameterUpdatedHandler");
    });

    it("throws and stays stopped when called a second time", async () => {
      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      await gm.start(gateway);
      await expect(gm.start(gateway)).rejects.toThrow(/already started/);
      expect(gm.isStarted()).toBe(true);
    });
  });

  describe("stop()", () => {
    it("sets isStarted() back to false after start()", async () => {
      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      await gm.start(gateway);
      await gm.stop();

      expect(gm.isStarted()).toBe(false);
    });

    it("is idempotent – calling stop() twice does not throw", async () => {
      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      await gm.start(gateway);
      await expect(gm.stop()).resolves.not.toThrow();
      await expect(gm.stop()).resolves.not.toThrow();
    });
  });

  describe("isGatewayCompliant() – uses status cache", () => {
    it("returns false for unknown gateway when cache is empty", async () => {
      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      await gm.start(gateway);

      const isCompliant = await gm.isGatewayCompliant("0x04" + "a".repeat(128));
      expect(isCompliant).toBe(false);
    });

    it("isGatewayCached() returns false before start", () => {
      const gm = buildGovernanceManager(monitorService);
      expect(gm.isGatewayCached("0xSomeAddress")).toBe(false);
    });

    it("getCachedGatewayStatus() returns undefined for uncached address", () => {
      const gm = buildGovernanceManager(monitorService);
      expect(gm.getCachedGatewayStatus("0xUnknown")).toBeUndefined();
    });

    it("status cache is case-insensitive (normalised to lower-case)", async () => {
      const gm = buildGovernanceManager(monitorService);

      const { OracleEVM } = jest.requireMock(
        "../../../../main/typescript/cross-chain-mechanisms/oracle/implementations/oracle-evm",
      ) as any;

      const gatewayAddress = "0xAbCd000000000000000000000000000000000001";
      OracleEVM.mockImplementationOnce(() => ({
        readEntry: (jest.fn() as any)
          .mockResolvedValueOnce({ output: [] })
          // Second call = GatewayRegistry.getAllGateways
          .mockResolvedValueOnce({
            output: [
              {
                gatewayAddress,
                status: 0,
              },
            ],
          }),
        subscribeContractEvent: (jest.fn() as any).mockResolvedValue(() => {}),
      }));

      const seededGm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();
      await seededGm.start(gateway);

      expect(seededGm.isGatewayCached(gatewayAddress.toLowerCase())).toBe(true);
      expect(seededGm.isGatewayCached(gatewayAddress.toUpperCase())).toBe(true);
      expect(seededGm.getCachedGatewayStatus(gatewayAddress)).toEqual(0);
    });
  });

  describe("bootstrapGatewayRegistryInfo – gateway pre-registered via DAO voting", () => {
    function seedOracleWithPreRegisteredGateway(
      gatewayAddress: string,
      status: 0 | 1 = 0,
    ) {
      const { OracleEVM } = jest.requireMock(
        "../../../../main/typescript/cross-chain-mechanisms/oracle/implementations/oracle-evm",
      ) as any;

      OracleEVM.mockImplementationOnce(() => ({
        readEntry: (jest.fn() as any)
          .mockResolvedValueOnce({ output: [] })
          .mockResolvedValueOnce({
            output: [{ gatewayAddress, status }],
          }),
        subscribeContractEvent: (jest.fn() as any).mockResolvedValue(() => {}),
      }));
    }

    it("populates the status cache for a gateway registered in DAO before start()", async () => {
      const gatewayAddress = "0xDead000000000000000000000000000000000001";
      seedOracleWithPreRegisteredGateway(gatewayAddress, 0);

      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();

      await gm.start(gateway);
      expect(gm.isGatewayCached(gatewayAddress)).toBe(true);
      expect(gm.getCachedGatewayStatus(gatewayAddress)).toEqual(0);
    });

    it("marks a pre-registered gateway as compliant without an extra oracle call", async () => {
      const gatewayAddress = "0xDead000000000000000000000000000000000002";

      seedOracleWithPreRegisteredGateway(gatewayAddress, 0);

      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();
      await gm.start(gateway);
      expect(gm.isGatewayCached(gatewayAddress)).toBe(true);
      expect(gm.getCachedGatewayStatus(gatewayAddress)).toBe(0);
    });

    it("marks a pre-registered but inactive gateway as non-compliant (status 1)", async () => {
      const gatewayAddress = "0xDead000000000000000000000000000000000003";

      seedOracleWithPreRegisteredGateway(gatewayAddress, 1);

      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();
      await gm.start(gateway);

      expect(gm.isGatewayCached(gatewayAddress)).toBe(true);
      expect(gm.getCachedGatewayStatus(gatewayAddress)).toEqual(1);
    });

    it("populates cache for multiple gateways registered before start()", async () => {
      const addresses = [
        "0xBee1000000000000000000000000000000000001",
        "0xBee2000000000000000000000000000000000002",
        "0xBee3000000000000000000000000000000000003",
      ];

      const { OracleEVM } = jest.requireMock(
        "../../../../main/typescript/cross-chain-mechanisms/oracle/implementations/oracle-evm",
      ) as any;

      OracleEVM.mockImplementationOnce(() => ({
        readEntry: (jest.fn() as any)
          .mockResolvedValueOnce({ output: [] })
          .mockResolvedValueOnce({
            output: addresses.map((gatewayAddress, i) => ({
              gatewayAddress,
              status: i === 1 ? 1 : 0,
            })),
          }),
        subscribeContractEvent: (jest.fn() as any).mockResolvedValue(() => {}),
      }));

      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();
      await gm.start(gateway);

      expect(gm.isGatewayCached(addresses[0])).toBe(true);
      expect(gm.getCachedGatewayStatus(addresses[0])).toEqual(0);

      expect(gm.isGatewayCached(addresses[1])).toBe(true);
      expect(gm.getCachedGatewayStatus(addresses[1])).toEqual(1);

      expect(gm.isGatewayCached(addresses[2])).toBe(true);
      expect(gm.getCachedGatewayStatus(addresses[2])).toEqual(0);
    });

    it("cache is empty when DAO has no registered gateways at start() time", async () => {
      const { OracleEVM } = jest.requireMock(
        "../../../../main/typescript/cross-chain-mechanisms/oracle/implementations/oracle-evm",
      ) as any;

      OracleEVM.mockImplementationOnce(() => ({
        readEntry: (jest.fn() as any)
          .mockResolvedValueOnce({ output: [] })
          .mockResolvedValueOnce({ output: [] }),
        subscribeContractEvent: (jest.fn() as any).mockResolvedValue(() => {}),
      }));

      const gm = buildGovernanceManager(monitorService);
      const gateway = buildGatewayMock();
      await gm.start(gateway);

      expect(gm.isGatewayCached("0xAnyAddress")).toBe(false);
    });
  });

  describe("unsupported ledger type", () => {
    it("throws in constructor for an unsupported ledger type", () => {
      expect(
        () =>
          new GovernanceManager({
            logLevel: LogLevel.DEBUG,
            monitorService,
            oracleConfig: {
              networkIdentification: {
                ledgerType: "FakeLedger" as any,
                id: "fake",
              },
            } as any,
            policyRegistry: {
              contractAddress: MOCK_POLICY_REGISTRY_ADDRESS,
              contractAbi: PolicyRegistryContract.abi,
            },
            gatewayRegistry: {
              contractAddress: MOCK_GATEWAY_REGISTRY_ADDRESS,
              contractAbi: GatewayRegistryContract.abi,
            },
          }),
      ).toThrow(/Unsupported ledger type/);
    });
  });
});
