// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract Token is ERC20, EIP712, ERC20Votes {
    constructor(
        string memory name,
        string memory symbol,
        uint256 supply,
        address dao
    ) ERC20(name, symbol) EIP712(name, "1") {
        _mint(dao, supply * 10 ** decimals());
    }

    function _update(address from, address to, uint256 amount)
        internal
        override(ERC20, ERC20Votes)
    {
        super._update(from, to, amount);
    }
}