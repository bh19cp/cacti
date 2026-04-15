import { Logger, LoggerProvider } from "@hyperledger/cactus-common";
import { context, SpanStatusCode, Exception } from "@opentelemetry/api";
import { IOracleListenerBase } from "../cross-chain-mechanisms/oracle/oracle-types";
import {
  BootstrapResult,
  GovernanceEvent,
  GovernanceEventSubscription,
  GovernanceManagerOptions,
  IGovernanceEventHandler,
  PolicyRegistryContractConfig,
} from "./governance-types";
import {
  EXPECTED_POLICY_KEYS,
  GatewayPolicyConfig,
  parsePolicyValue,
  PolicyKey,
} from "./governance-policy-config";
import { IEVMOracleEntry } from "../cross-chain-mechanisms/oracle/implementations/oracle-evm";

interface OnChainParameter {
  key: string;
  value: string | bigint;
  createdAt: string | bigint;
  updatedAt: string | bigint;
  exists: boolean;
}

const POLICY_REGISTRY_EVENTS: GovernanceEventSubscription[] = [
  {
    eventSignature: "ParameterUpdated(string,uint256,uint256,uint256)",
    paramNames: ["key", "oldValue", "newValue", "timestamp"],
  },
  {
    eventSignature: "ParameterAdded(string,uint256,uint256)",
    paramNames: ["key", "value", "timestamp"],
  },
  {
    eventSignature: "ParameterRemoved(string,uint256)",
    paramNames: ["key", "timestamp"],
  },
];

const GATEWAY_REGISTRY_EVENTS: GovernanceEventSubscription[] = [
  {
    eventSignature: "OrganizationRegistered(address,string,uint256)",
    paramNames: ["orgAddress", "name", "stake"],
  },
  {
    eventSignature: "OrganizationStatusChanged(address,uint256)",
    paramNames: ["orgAddress", "status"],
  },
  {
    eventSignature: "OrganizationRemoved(address,uint256)",
    paramNames: ["orgAddress", "timestamp"],
  },
  {
    eventSignature: "GatewayRegistered(address,string,uint256)",
    paramNames: ["gatewayAddress", "name", "timestamp"],
  },
  {
    eventSignature: "GatewayStatusChanged(address,uint256)",
    paramNames: ["gatewayAddress", "status"],
  },
  {
    eventSignature: "GatewayRemoved(address,uint256)",
    paramNames: ["gatewayAddress", "timestamp"],
  },
];

export class GovernanceManager {
  public static readonly CLASS_NAME = "GovernanceManager";
  private static readonly POLICY_REGISTRY_CONTRACT_NAME = "PolicyRegistry";
  private static readonly GATEWAY_REGISTRY_CONTRACT_NAME = "GatewayRegistry";

  private readonly log: Logger;
  private readonly handlers = new Map<string, IGovernanceEventHandler>();
  private readonly activeSubscriptions = new Map<string, () => void>();
  private started = false;

  constructor(private readonly options: GovernanceManagerOptions) {
    const fnTag = `${GovernanceManager.CLASS_NAME}#constructor()`;
    if (!options) throw new Error(`${fnTag}: options are required`);

    this.log = LoggerProvider.getOrCreate({
      label: GovernanceManager.CLASS_NAME,
      level: options.logLevel ?? "INFO",
    });

    this.log.info(`${fnTag}: initialized`);
  }

  public registerHandler(handler: IGovernanceEventHandler): this {
    const fnTag = `${GovernanceManager.CLASS_NAME}#registerHandler()`;
    if (this.handlers.has(handler.id)) {
      throw new Error(`${fnTag}: handler '${handler.id}' already registered`);
    }
    this.handlers.set(handler.id, handler);
    this.log.info(`${fnTag}: registered handler '${handler.id}'`);
    return this;
  }

  public unregisterHandler(id: string): boolean {
    return this.handlers.delete(id);
  }

  public getHandlerIds(): string[] {
    return [...this.handlers.keys()];
  }

  public async start(): Promise<void> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#start()`;
    const { span, context: ctx } = this.options.monitorService.startSpan(fnTag);

    await context.with(ctx, async () => {
      try {
        if (this.started) throw new Error(`${fnTag}: already started`);

        const { policyConfig, missingKeys } =
          await this.bootstrapPolicyRegistry();

        if (missingKeys.length > 0) {
          this.log.warn(
            `${fnTag}: Missing expected policy keys on-chain: [${missingKeys.join(", ")}]`,
          );
        }

        this.log.info(
          `${fnTag}: Applying bootstrapped policy config to gateway`,
        );
        await this.options.gateway.applyPolicyConfig(policyConfig);
        this.log.info(`${fnTag}: Policy config applied`);

        await this.attachContractSubscriptions(
          GovernanceManager.POLICY_REGISTRY_CONTRACT_NAME,
          this.options.policyRegistry,
          POLICY_REGISTRY_EVENTS,
        );

        await this.attachContractSubscriptions(
          GovernanceManager.GATEWAY_REGISTRY_CONTRACT_NAME,
          this.options.gatewayRegistry,
          GATEWAY_REGISTRY_EVENTS,
        );

        this.started = true;
        this.log.info(
          `${fnTag}: Started with ${this.activeSubscriptions.size} active subscription(s)`,
        );
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        span.recordException(err as Exception);
        throw err;
      } finally {
        span.end();
      }
    });
  }

  public async stop(): Promise<void> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#stop()`;
    this.log.info(`${fnTag}: Stopping...`);
    this.activeSubscriptions.forEach((unsub) => unsub());
    this.activeSubscriptions.clear();
    this.started = false;
    this.log.info(`${fnTag}: Stopped.`);
  }

  public isStarted(): boolean {
    return this.started;
  }

  private async bootstrapPolicyRegistry(): Promise<BootstrapResult> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#bootstrapPolicyRegistry()`;
    this.log.info(`${fnTag}: Fetching all parameters from PolicyRegistry...`);

    const response = await this.options.oracle.readEntry({
      contractName: "PolicyRegistry",
      contractAddress: this.options.policyRegistry.contractAddress,
      contractAbi: this.options.policyRegistry.contractAbi as any[],
      contractBytecode: "",
      methodName: "getAllParameters",
      params: [],
    } as IEVMOracleEntry);

    this.log.info(`${fnTag}: response to get all parameters: ${response}`);
    const onChain = response.output as unknown as OnChainParameter[];
    const onChainMap = new Map(
      onChain.filter((p) => p.exists).map((p) => [p.key, BigInt(p.value)]),
    );

    this.log.info(
      `${fnTag}: Found ${onChainMap.size} parameter(s) on-chain: ` +
        `[${[...onChainMap.keys()].join(", ")}]`,
    );

    const partial: Partial<GatewayPolicyConfig> = {};
    const missingKeys: string[] = [];

    for (const key of EXPECTED_POLICY_KEYS) {
      const rawValue = onChainMap.get(key);
      if (rawValue === undefined) {
        missingKeys.push(key);
        continue;
      }

      try {
        (partial as Record<string, unknown>)[key] = parsePolicyValue(
          key,
          rawValue,
        );
        this.log.debug(
          `${fnTag}: Parsed key=${key} raw=${rawValue} → ${partial[key as PolicyKey]}`,
        );
      } catch (err) {
        this.log.error(`${fnTag}: Failed to parse key=${key}: ${err}`);
        missingKeys.push(key);
      }
    }

    return {
      policyConfig: partial as GatewayPolicyConfig,
      missingKeys,
    };
  }

  private async attachContractSubscriptions(
    contractName: string,
    contract: PolicyRegistryContractConfig,
    events: GovernanceEventSubscription[],
  ): Promise<void> {
    for (const eventSub of events) {
      const key = `${contract.contractAddress}::${eventSub.eventSignature}`;
      if (this.activeSubscriptions.has(key)) continue;

      const unsubscribe = await this.options.oracle.subscribeContractEvent(
        {
          contractName,
          contractAbi: contract.contractAbi,
          contractAddress: contract.contractAddress,
          eventSignature: eventSub.eventSignature,
        } as IOracleListenerBase,
        (rawParams: string[]) => {
          const event = this.normalizeEvent(
            contractName,
            contract.contractAddress,
            eventSub,
            rawParams,
          );
          void this.dispatch(event);
        },
      );

      this.activeSubscriptions.set(
        key,
        typeof unsubscribe === "function" ? unsubscribe : () => {},
      );

      this.log.debug(
        `Subscribed: ${contractName} :: ${eventSub.eventSignature}`,
      );
    }
  }

  private normalizeEvent(
    contractName: string,
    contractAddress: string,
    eventSub: GovernanceEventSubscription,
    raw: string[],
  ): GovernanceEvent {
    const expectedLength = eventSub.paramNames?.length ?? 0;
    let alignedRaw = raw;

    // Connector always adds length as leading value
    if (raw.length === expectedLength + 1 && !isNaN(Number(raw[0]))) {
      alignedRaw = raw.slice(1);
      this.log.warn(
        `normalizeEvent: stripped leading length value "${raw[0]}"`,
      );
    }

    const params: Record<string, unknown> = {};
    (eventSub.paramNames ?? []).forEach((name, i) => {
      params[name] = alignedRaw[i];
    });

    return {
      eventSignature: eventSub.eventSignature,
      contractAddress,
      contractName,
      params,
      raw: alignedRaw,
    };
  }
  private async dispatch(event: GovernanceEvent): Promise<void> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#dispatch()`;

    this.log.debug(
      `${fnTag}: Received event:\n${JSON.stringify(event, null, 2)}`,
    );
    const eligible = [...this.handlers.values()].filter(
      (h) =>
        (h.interestedEvents.includes("*") ||
          h.interestedEvents.includes(event.eventSignature)) &&
        (h.filter ? h.filter(event) : true),
    );

    if (eligible.length === 0) return;

    this.log.debug(
      `${fnTag}: '${event.eventSignature}' → ${eligible.length} handler(s)`,
    );

    const results = await Promise.allSettled(
      eligible.map((h) => h.handle(event)),
    );

    results.forEach((result, i) => {
      if (result.status === "rejected") {
        this.log.error(
          `${fnTag}: Handler '${eligible[i].id}' failed: ${result.reason}`,
        );
      }
    });
  }
}
