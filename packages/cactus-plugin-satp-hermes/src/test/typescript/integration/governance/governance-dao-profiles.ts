import { GovernanceConfig } from "./governance-config/governance-config";

export enum DaoProfile {
  NoTimelock_TokenBased = 1,
  NoTimelock_Quadratic,
  NoTimelock_WeightedReputation,
  Timelock_TokenBased,
  Timelock_Quadratic,
  Timelock_WeightedReputation,
}

export function buildProfileConfig(profile: DaoProfile): GovernanceConfig {
  const timelockEnabled = profile > 3;
  let votingSystem: string;
  switch (profile) {
    case DaoProfile.NoTimelock_TokenBased:
    case DaoProfile.Timelock_TokenBased:
      votingSystem = "token-based";
      break;
    case DaoProfile.NoTimelock_Quadratic:
    case DaoProfile.Timelock_Quadratic:
      votingSystem = "quadratic";
      break;
    default:
      votingSystem = "weighted-reputation";
  }

  return {
    name: `DAO-profile-${profile}`,
    tokenomics: {
      name: "GovernanceToken",
      symbol: "GOV",
      supply: 1_000_000,
      defaultMemberTokens: 1000,
    },
    governance: {
      votingDelay: 1,
      votingPeriod: 10,
      proposalThreshold: 0,
      quorumFraction: 4,
      votingSystem,
    },
    timelock: {
      enabled: timelockEnabled,
      minDelay: timelockEnabled ? 1 : 0,
    },
    organizations: [], // no orgs for fixed cost
    protocolParameters: [], // no params for fixed cost
  };
}
