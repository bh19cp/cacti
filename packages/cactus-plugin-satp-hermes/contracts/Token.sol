// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract Token is ERC20, EIP712, ERC20Votes {

    address public governance;

    constructor(
        string memory name,
        string memory symbol,
        uint256 supply,
        address dao
    ) ERC20(name, symbol) EIP712(name, "1") {
        governance = dao;
        _mint(dao, supply * 10 ** decimals());
        
    }

    modifier onlyGovernance() {
        require(msg.sender == governance, "Token: not governance");
        _;
    }

    function reclaimTokensToAddress(address account, address recipient) external onlyGovernance {
        uint256 amount = balanceOf(account);
        if (amount == 0) return;
        _transfer(account, recipient, amount);
    }

    function burnAllTokensFromAccount(address account) external onlyGovernance {
        _burn(account, balanceOf(account));
    }

    function transferOwnership(address newGovernance) external onlyGovernance {
        require(newGovernance != address(0), "Token: zero address");
        governance = newGovernance;
    }

    function _update(address from, address to, uint256 amount)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, amount);
    }
}