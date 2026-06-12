export interface GovernanceConfig {
  name: string;
  tokenomics: {
    name: string;
    symbol: string;
    supply: number;
    defaultMemberTokens: number;
  };
  organizations: Array<{
    address: string;
    name: string;
    gateways: Array<{
      publicKey: string;
      name: string;
    }>;
    reputation?: number;
  }>;
  governance: {
    votingPeriod: number;
    votingDelay: number;
    proposalThreshold: number;
    quorumFraction: number;
    votingSystem: string;
  };
  timelock: {
    enabled: boolean;
    minDelay: number;
  };
  protocolParameters: Array<{ key: string; value: string }>;
}
