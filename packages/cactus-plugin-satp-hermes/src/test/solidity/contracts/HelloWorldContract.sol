// SPDX-License-Identifier: GPL-3.0

pragma solidity >=0.7.0;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract HelloWorldContract is AccessControl {

    // Define a role for those who can update the message
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // Private state variable to store the message
    string private message;

    // Event emitted when the message is updated (similar to UpdatedData)
    event MessageUpdated(string oldMessage, string newMessage, uint256 nonce);

    // Nonce to track updates (matching the pattern in OracleTestContract)
    uint256 private nonce = 0;

    // Getter for nonce
    function getNonce() external view returns (uint256) {
        return nonce;
    }

    // Internal function to increment nonce, restricted to ORACLE_ROLE
    function incrementNonce() internal onlyRole(ORACLE_ROLE) {
        nonce++;
    }

    // No-argument constructor – grants roles and sets initial message
    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, msg.sender);
        message = "hello world";
    }

    // Setter function – only callable by accounts with ORACLE_ROLE
    function setMessage(string memory newMessage) external onlyRole(ORACLE_ROLE) {
        string memory oldMessage = message;
        message = newMessage;
        incrementNonce();
        emit MessageUpdated(oldMessage, newMessage, nonce);
    }

    // Getter function – anyone can view the current message
    function getMessage() external view returns (string memory) {
        return message;
    }
}