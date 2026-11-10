import {
  IGovernanceEventHandler,
  GovernanceEvent,
  GatewayStatus,
  GatewayRegistryEventSignatures,
} from "../governance-types";

export class GatewayStatusHandler implements IGovernanceEventHandler {
  public readonly id = "GatewayStatusHandler";
  public readonly interestedEvents = [
    GatewayRegistryEventSignatures.GATEWAY_STATUS_CHANGED,
    GatewayRegistryEventSignatures.GATEWAY_REGISTERED,
    GatewayRegistryEventSignatures.GATEWAY_REMOVED,
  ];

  constructor(private readonly statusCache: Map<string, number>) {}

  async handle(event: GovernanceEvent): Promise<void> {
    const raw = event.params.publicKey as string | undefined;
    if (!raw) return;
    const key = (raw.startsWith("0x") ? raw : "0x" + raw).toLowerCase();

    switch (event.eventSignature) {
      case GatewayRegistryEventSignatures.GATEWAY_STATUS_CHANGED:
        this.statusCache.set(key, Number(event.params.newStatus));
        break;
      case GatewayRegistryEventSignatures.GATEWAY_REGISTERED:
        this.statusCache.set(key, GatewayStatus.Active);
        break;
      case GatewayRegistryEventSignatures.GATEWAY_REMOVED:
        this.statusCache.delete(key);
        break;
    }
  }
}
