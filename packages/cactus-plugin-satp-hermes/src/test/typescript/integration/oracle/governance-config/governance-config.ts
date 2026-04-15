export interface GovernanceConfig {
  name: string;
  tokenomics: {
    treasury: boolean;
    name: string;
    symbol: string;
    supply: number;
    defaultMemberTokens: number;
  };
  organizations: Array<{
    address: string;
    name: string;
    gateways: string[];
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
