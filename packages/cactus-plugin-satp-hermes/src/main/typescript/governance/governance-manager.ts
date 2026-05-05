import { Logger, LoggerProvider } from "@hyperledger/cactus-common";
import { context, SpanStatusCode, Exception } from "@opentelemetry/api";
import { IOracleListenerBase } from "../cross-chain-mechanisms/oracle/oracle-types";
import {
  ContractInfo,
  GATEWAY_REGISTRY_EVENT_SUBSCRIPTIONS,
  GovernanceEvent,
  GovernanceEventSubscription,
  GovernanceManagerOptions,
  IGatewayPolicyManager,
  IGovernanceEventHandler,
  OnChainGateway,
  OnChainParameter,
  POLICY_REGISTRY_EVENT_SUBSCRIPTIONS,
} from "./governance-types";
import {
  DEFAULT_RUNTIME_POLICY,
  EXPECTED_POLICY_KEYS,
  parsePolicyEntry,
  PolicyKey,
  RuntimePolicy,
} from "./governance-policy-config";
import { IEVMOracleEntry } from "../cross-chain-mechanisms/oracle/implementations/oracle-evm";
import { IGatewayComplianceVerifier } from "./governance-types";
import { GatewayStatusHandler } from "./handlers/GatewayStatusHandler";
import { ethers } from "ethers";
import { SATPGateway } from "../plugin-satp-hermes-gateway";
import { ParameterUpdatedHandler } from "./handlers/ParameterUpdatedHandler";
import { OracleAbstract } from "../cross-chain-mechanisms/oracle/oracle-abstract";
import { OracleFactory } from "../cross-chain-mechanisms/oracle/oracle-factory";

export class GovernanceManager
  implements IGatewayComplianceVerifier, IGatewayPolicyManager
{
  public static readonly CLASS_NAME = "GovernanceManager";
  private static readonly POLICY_REGISTRY_CONTRACT_NAME = "PolicyRegistry";
  private static readonly GATEWAY_REGISTRY_CONTRACT_NAME = "GatewayRegistry";

  private readonly log: Logger;
  private readonly handlers = new Map<string, IGovernanceEventHandler>();
  private readonly activeSubscriptions = new Map<string, () => void>();
  private gatewayStatusCache = new Map<string, number>();
  private started = false;
  private readonly oracle: OracleAbstract;
  private runtimePolicy: RuntimePolicy = { ...DEFAULT_RUNTIME_POLICY };

  constructor(private readonly options: GovernanceManagerOptions) {
    const fnTag = `${GovernanceManager.CLASS_NAME}#constructor()`;
    if (!options) throw new Error(`${fnTag}: options are required`);

    this.log = LoggerProvider.getOrCreate({
      label: GovernanceManager.CLASS_NAME,
      level: options.logLevel ?? "INFO",
    });

    this.oracle = OracleFactory.create(options.oracleConfig, {
      logLevel: options.logLevel ?? "INFO",
      monitorService: options.monitorService,
    });
    this.log.info(`${fnTag}: initialized`);
  }

  public async isGatewayCompliant(publicKey: string): Promise<boolean> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#isGatewayCompliant()`;
    try {
      const gatewayAddress = this.publicKeyToAddress(publicKey);
      if (!gatewayAddress) {
        this.log.warn(`${fnTag}: Could not derive address from public key`);
        return false;
      }
      const normalizedAddress = gatewayAddress.toLowerCase();
      if (this.gatewayStatusCache.has(normalizedAddress)) {
        const status = this.gatewayStatusCache.get(normalizedAddress)!;
        return status === 0;
      }
      this.log.debug(`${fnTag}: checking compliance for ${normalizedAddress}`);
      const response = await this.oracle.readEntry({
        contractName: GovernanceManager.GATEWAY_REGISTRY_CONTRACT_NAME,
        contractAddress: this.options.gatewayRegistry.contractAddress,
        contractAbi: this.options.gatewayRegistry.contractAbi as any[],
        contractBytecode: "",
        methodName: "isGatewayActive",
        params: [gatewayAddress],
      } as IEVMOracleEntry);

      const isActive = response.output as unknown as boolean;
      this.gatewayStatusCache.set(normalizedAddress, isActive ? 0 : 1);
      return isActive;
    } catch (err) {
      this.log.error(
        `${fnTag}: failed to check compliance for ${publicKey}`,
        err,
      );
      return false;
    }
  }

  private publicKeyToAddress(pubKeyHex: string): string {
    try {
      const prefixed = pubKeyHex.startsWith("0x")
        ? pubKeyHex
        : "0x" + pubKeyHex;
      const computeAddress =
        (ethers as any).computeAddress || (ethers as any).utils?.computeAddress;
      if (!computeAddress) {
        this.log.error("ethers.computeAddress is not available");
        return "";
      }
      return computeAddress(prefixed);
    } catch (err) {
      this.log.debug(`publicKeyToAddress failed for ${pubKeyHex}: ${err}`);
      return "";
    }
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

  public async start(gateway: SATPGateway): Promise<void> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#start()`;
    const { span, context: ctx } = this.options.monitorService.startSpan(fnTag);

    await context.with(ctx, async () => {
      try {
        if (this.started) throw new Error(`${fnTag}: already started`);

        const { policy, missingKeys } = await this.bootstrapPolicyRegistry();

        if (missingKeys.length > 0) {
          this.log.warn(
            `${fnTag}: Missing expected policy keys on-chain: [${missingKeys.join(", ")}]`,
          );
        }

        this.log.info(
          `${fnTag}: Applying policy registry on-chain config to gateway`,
        );
        await gateway.applyPolicyConfig(policy);
        this.log.info(`${fnTag}: Policy config applied`);

        this.log.info(
          `${fnTag}: Pull on-chain gateway registry information bootstrapped policy config to gateway`,
        );
        await this.bootstrapGatewayRegistryInfo();
        this.log.info(
          `${fnTag}: pull of gateway registry information completed`,
        );

        this.registerHandler(new GatewayStatusHandler(this.gatewayStatusCache));
        this.log.info(`${fnTag}: Registered gateway status handler`);
        this.registerHandler(new ParameterUpdatedHandler(gateway));
        this.log.info(`${fnTag}: Registered Parameter Updated handler`);
        await this.attachContractSubscriptions(
          GovernanceManager.POLICY_REGISTRY_CONTRACT_NAME,
          this.options.policyRegistry,
          POLICY_REGISTRY_EVENT_SUBSCRIPTIONS,
        );

        await this.attachContractSubscriptions(
          GovernanceManager.GATEWAY_REGISTRY_CONTRACT_NAME,
          this.options.gatewayRegistry,
          GATEWAY_REGISTRY_EVENT_SUBSCRIPTIONS,
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

  private async bootstrapPolicyRegistry(): Promise<{
    policy: Partial<RuntimePolicy>;
    missingKeys: string[];
  }> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#bootstrapPolicyRegistry()`;
    this.log.info(`${fnTag}: Fetching all parameters from PolicyRegistry...`);

    const response = await this.oracle.readEntry({
      contractName: "PolicyRegistry",
      contractAddress: this.options.policyRegistry.contractAddress,
      contractAbi: this.options.policyRegistry.contractAbi as any[],
      contractBytecode: "",
      methodName: "getAllParameters",
      params: [],
    } as IEVMOracleEntry);

    const onChain = response.output as unknown as OnChainParameter[];
    const onChainMap = new Map(
      onChain.filter((p) => p.exists).map((p) => [p.key, BigInt(p.value)]),
    );

    this.log.info(
      `${fnTag}: Found ${onChainMap.size} parameter(s) on-chain: ` +
        `[${[...onChainMap.keys()].join(", ")}]`,
    );

    const policy: Partial<RuntimePolicy> = {};
    const missingKeys: string[] = [];

    for (const key of EXPECTED_POLICY_KEYS) {
      const rawValue = onChainMap.get(key);
      if (rawValue === undefined) {
        missingKeys.push(key);
        continue;
      }
      try {
        Object.assign(policy, parsePolicyEntry(key as PolicyKey, rawValue));
        this.log.debug(`${fnTag}: Parsed key=${key} raw=${rawValue}`);
      } catch (err) {
        this.log.error(`${fnTag}: Failed to parse key=${key}: ${err}`);
        missingKeys.push(key);
      }
    }

    return { policy, missingKeys };
  }
  public applyPolicyConfig(patch: Partial<RuntimePolicy>): void {
    Object.assign(this.runtimePolicy, patch);
    this.log.info(
      `${GovernanceManager.CLASS_NAME}#applyPolicyConfig(): applied ${JSON.stringify(
        patch,
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      )}`,
    );
  }

  public getRuntimePolicy(): RuntimePolicy {
    return { ...this.runtimePolicy };
  }

  private async bootstrapGatewayRegistryInfo(): Promise<void> {
    const fnTag = `${GovernanceManager.CLASS_NAME}#bootstrapGatewayRegistryInfo()`;
    this.log.info(
      `${fnTag}: Pull on-chain gateway registry information bootstrapped policy config to gateway`,
    );

    try {
      const resp = await this.oracle.readEntry({
        contractName: GovernanceManager.GATEWAY_REGISTRY_CONTRACT_NAME,
        contractAddress: this.options.gatewayRegistry.contractAddress,
        contractAbi: this.options.gatewayRegistry.contractAbi as any[],
        contractBytecode: "",
        methodName: "getAllGateways",
        params: [],
      } as IEVMOracleEntry);

      const gateways = resp.output as unknown as OnChainGateway[];

      for (const gw of gateways) {
        this.gatewayStatusCache.set(
          gw.gatewayAddress.toLowerCase(),
          Number(gw.status),
        );
      }

      this.log.info(
        `${fnTag}: Bootstrapped ${gateways.length} gateway(s) into cache`,
      );
    } catch (err: any) {
      this.log.error(
        `${fnTag}: Failed to bootstrap gateway registry info`,
        err,
      );
    }
  }

  private async attachContractSubscriptions(
    contractName: string,
    contract: ContractInfo,
    events: GovernanceEventSubscription[],
  ): Promise<void> {
    for (const eventSub of events) {
      const key = `${contract.contractAddress}::${eventSub.eventSignature}`;
      if (this.activeSubscriptions.has(key)) continue;

      const unsubscribe = await this.oracle.subscribeContractEvent(
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
  /**
   * Returns the cached status of a gateway.
   * @param gatewayAddress - The Ethereum address of the gateway (0x…).
   * @returns The status value (0 = active, 1 = inactive) or `undefined` if the address is not in the cache.
   */
  public getCachedGatewayStatus(gatewayAddress: string): number | undefined {
    return this.gatewayStatusCache.get(gatewayAddress.toLowerCase());
  }

  /**
   * Checks whether a gateway address is present in the local status cache.
   * @param gatewayAddress - The Ethereum address of the gateway (0x…).
   * @returns `true` if the address exists in the cache, `false` otherwise.
   */
  public isGatewayCached(gatewayAddress: string): boolean {
    return this.gatewayStatusCache.has(gatewayAddress.toLowerCase());
  }
}
