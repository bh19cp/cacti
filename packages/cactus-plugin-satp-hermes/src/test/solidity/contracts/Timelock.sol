// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/TimelockController.sol";

contract Timelock is TimelockController {
    // minDelay: delay in seconds before execution
    // proposers: addresses allowed to queue proposals
    // executors: addresses allowed to execute proposals (empty = anyone)
    // admin: initial admin
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    )
        TimelockController(minDelay, proposers, executors, admin)
    {}
}