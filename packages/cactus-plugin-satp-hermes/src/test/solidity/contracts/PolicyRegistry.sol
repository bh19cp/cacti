// contracts/PolicyRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract PolicyRegistry is Ownable {

    struct Parameter {
        string  key;
        uint256 value;
        uint256 createdAt;
        uint256 updatedAt;
        bool    exists;
    }

    mapping(string => Parameter) public parameters;
    string[] public parameterKeys;

    event ParameterAdded(string key, uint256 value, uint256 timestamp);
    event ParameterUpdated(string key, uint256 oldValue, uint256 newValue, uint256 timestamp);
    event ParameterRemoved(string key, uint256 timestamp);

    error ParameterAlreadyExists(string key);
    error ParameterNotFound(string key);
    error EmptyKey();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function addParameter(
        string calldata key,
        uint256 value
    ) external onlyOwner {
        if (bytes(key).length == 0) revert EmptyKey();
        if (parameters[key].exists) revert ParameterAlreadyExists(key);

        parameters[key] = Parameter({
            key:       key,
            value:     value,
            createdAt: block.timestamp,
            updatedAt: block.timestamp,
            exists:    true
        });

        parameterKeys.push(key);
        emit ParameterAdded(key, value, block.timestamp);
    }

    function setParameter(
        string calldata key,
        uint256 newValue
    ) external onlyOwner {
        if (!parameters[key].exists) revert ParameterNotFound(key);

        uint256 oldValue = parameters[key].value;
        parameters[key].value     = newValue;
        parameters[key].updatedAt = block.timestamp;

        emit ParameterUpdated(key, oldValue, newValue, block.timestamp);
    }

    function removeParameter(string calldata key) external onlyOwner {
        if (!parameters[key].exists) revert ParameterNotFound(key);

        for (uint256 i = 0; i < parameterKeys.length; i++) {
            if (keccak256(bytes(parameterKeys[i])) == keccak256(bytes(key))) {
                parameterKeys[i] = parameterKeys[parameterKeys.length - 1];
                parameterKeys.pop();
                break;
            }
        }

        delete parameters[key];
        emit ParameterRemoved(key, block.timestamp);
    }

    // functions to be called from outside of this contract (testing)

    function getParameter(string calldata key)
        external view
        returns (Parameter memory)
    {
        if (!parameters[key].exists) revert ParameterNotFound(key);
        return parameters[key];
    }

    function getValue(string calldata key)
        external view
        returns (uint256)
    {
        if (!parameters[key].exists) revert ParameterNotFound(key);
        return parameters[key].value;
    }

    function getAllParameters()
        external view
        returns (Parameter[] memory)
    {
        Parameter[] memory result = new Parameter[](parameterKeys.length);
        for (uint256 i = 0; i < parameterKeys.length; i++) {
            result[i] = parameters[parameterKeys[i]];
        }
        return result;
    }

    function getParameterCount() external view returns (uint256) {
        return parameterKeys.length;
    }

    function parameterExists(string calldata key) external view returns (bool) {
        return parameters[key].exists;
    }
}