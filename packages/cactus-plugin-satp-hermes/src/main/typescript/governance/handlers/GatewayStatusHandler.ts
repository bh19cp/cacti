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
    const gatewayAddress = (
      event.params.gatewayAddress as string
    ).toLowerCase();

    switch (event.eventSignature) {
      case GatewayRegistryEventSignatures.GATEWAY_STATUS_CHANGED:
        this.statusCache.set(gatewayAddress, Number(event.params.newStatus));
        break;
      case GatewayRegistryEventSignatures.GATEWAY_REGISTERED:
        this.statusCache.set(gatewayAddress, GatewayStatus.Active);
        break;
      case GatewayRegistryEventSignatures.GATEWAY_REMOVED:
        this.statusCache.delete(gatewayAddress);
        break;
    }
  }
}
