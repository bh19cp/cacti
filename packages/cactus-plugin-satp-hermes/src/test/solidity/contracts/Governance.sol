// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Governor}                    from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorCountingSimple}      from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorSettings}            from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorVotes}               from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {IVotes}                      from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {Math}                        from "@openzeppelin/contracts/utils/math/Math.sol";
import {GatewayRegistry}             from "./GatewayRegistry.sol";

contract Governance is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction
{
    enum VotingSystem {
        TokenBased,          // 0: standard ERC20Votes weight (default)
        Quadratic,           // 1: sqrt(tokenVotes) — reduces whale dominance
        WeightedReputation   // 2: tokenVotes boosted by GatewayRegistry reputation
    }

    /// only needed for WeightedReputation, address(0) otherwise
    GatewayRegistry public gatewayRegistry;
    VotingSystem public defaultVotingSystem;

    mapping(uint256 => VotingSystem) public proposalVotingSystem;

    /// @notice Transient context: set at start of _castVote, read by _getVotes.
    /// Safe because _castVote → super._castVote → _getVotes all run in one call stack.
    /// Reset after each vote to keep storage clean between transactions.
    VotingSystem private _activeVotingSystem;

    error RegistryNotSet();

    constructor(
        string memory governorName,
        IVotes _token,
        uint32  _votingDelay,
        uint32  _votingPeriod,
        uint256 _proposalThreshold,
        uint256 _quorumFraction,
        VotingSystem _defaultVotingSystem,
        GatewayRegistry _gatewayRegistry 
    )
        Governor(governorName)
        GovernorSettings(_votingDelay, _votingPeriod, _proposalThreshold)
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(_quorumFraction)
    {
        if (
            _defaultVotingSystem == VotingSystem.WeightedReputation &&
            address(_gatewayRegistry) == address(0)
        ) revert RegistryNotSet();

        defaultVotingSystem = _defaultVotingSystem;
        gatewayRegistry     = _gatewayRegistry;
    }

    function setDefaultVotingSystem(VotingSystem newSystem) external onlyGovernance {
        if (
            newSystem == VotingSystem.WeightedReputation &&
            address(gatewayRegistry) == address(0)
        ) revert RegistryNotSet();

        defaultVotingSystem = newSystem;
    }

    function setGatewayRegistry(GatewayRegistry newRegistry) external onlyGovernance {
        gatewayRegistry = newRegistry;
    }


    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override returns (uint256) {
        uint256 proposalId = super.propose(targets, values, calldatas, description);
        _assignVotingSystem(proposalId, defaultVotingSystem);
        return proposalId;
    }

    function _assignVotingSystem(uint256 proposalId, VotingSystem vs) internal {
        proposalVotingSystem[proposalId] = vs;
    }

    function _castVote(
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory params
    ) internal override returns (uint256) {
        _activeVotingSystem = proposalVotingSystem[proposalId];
        uint256 weight = super._castVote(proposalId, account, support, reason, params);
        delete _activeVotingSystem;
        return weight;
    }


    function _getVotes(
        address account,
        uint256 timepoint,
        bytes memory params
    )
        internal view
        override(Governor, GovernorVotes)
        returns (uint256)
    {
        uint256 tokenVotes = super._getVotes(account, timepoint, params);
        VotingSystem vs = _activeVotingSystem;

        if (vs == VotingSystem.TokenBased) {
            return tokenVotes;
        }

        if (vs == VotingSystem.Quadratic) {
            return Math.sqrt(tokenVotes);
        }

        // WeightedReputation: using 10_000 base avoids floating point
        if (vs == VotingSystem.WeightedReputation) {
            if (address(gatewayRegistry) == address(0)) return tokenVotes;
            uint256 reputation = gatewayRegistry.getReputationAt(account, timepoint);
            return tokenVotes * (10_000 + reputation) / 10_000;
        }

        return tokenVotes;
    }

    function votingDelay()
        public view override(Governor, GovernorSettings) returns (uint256)
    { return super.votingDelay(); }

    function votingPeriod()
        public view override(Governor, GovernorSettings) returns (uint256)
    { return super.votingPeriod(); }

    function proposalThreshold()
        public view override(Governor, GovernorSettings) returns (uint256)
    { return super.proposalThreshold(); }

    function quorum(uint256 blockNumber)
        public view override(Governor, GovernorVotesQuorumFraction) returns (uint256)
    { return super.quorum(blockNumber); }

}
