// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract GatewayRegistry is Ownable {

    uint256 public constant MAX_REPUTATION = 10_000;
    enum OrgStatus    { Active, Suspended, Probation, Inactive }
    enum GatewayStatus { Active, Suspended, Revoked }

    struct Organization {
        string    name;
        address   wallet;
        OrgStatus status;
        uint256   registeredAt;
        uint256   updatedAt;
        bool      exists;
        uint256   reputation;   
    }

    struct Gateway {
        bytes         publicKey;  
        address       orgWallet;
        string        name;
        GatewayStatus status;
        uint256       registeredAt;
        uint256       updatedAt;
        bool          exists;
    }

    mapping(address => Organization) public organizations;
    mapping(bytes => Gateway)        public gateways;          
    mapping(address => bytes[])      public orgGateways;       

    address[] public orgList;
    bytes[]   public gatewayList;                              

    mapping(address => mapping(uint256 => uint256)) private _reputationSnapshots;
    mapping(address => uint256[])                   private _snapshotBlocks;

    event OrganizationRegistered(address indexed wallet, string name, uint256 timestamp);
    event OrganizationStatusChanged(address indexed wallet, OrgStatus oldStatus, OrgStatus newStatus, string reason);
    event OrganizationRemoved(address indexed wallet, string reason);
    event GatewayRegistered(bytes publicKey, address indexed orgWallet, uint256 timestamp);
    event GatewayStatusChanged(bytes publicKey, GatewayStatus oldStatus, GatewayStatus newStatus, string reason);
    event GatewayRemoved(bytes publicKey, string reason);

    error OrgAlreadyExists(address wallet);
    error OrgNotFound(address wallet);
    error GatewayAlreadyExists(bytes publicKey);
    error GatewayNotFound(bytes publicKey);
    error InvalidAddress();
    error InvalidPublicKey();          
    error ReputationOutOfRange(uint256 value, uint256 max);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function registerOrganization(
        address wallet,
        string calldata name,
        uint256 initialReputation          
    ) external onlyOwner {
        if (wallet == address(0)) revert InvalidAddress();
        if (organizations[wallet].exists)  revert OrgAlreadyExists(wallet);
        if (initialReputation > MAX_REPUTATION)
            revert ReputationOutOfRange(initialReputation, MAX_REPUTATION);

        organizations[wallet] = Organization({
            name:         name,
            wallet:       wallet,
            status:       OrgStatus.Active,
            registeredAt: block.timestamp,
            updatedAt:    block.timestamp,
            exists:       true,
            reputation:   initialReputation   
        });

        _takeSnapshot(wallet);               
        orgList.push(wallet);
        emit OrganizationRegistered(wallet, name, block.timestamp);
    }

    function setOrganizationStatus(address wallet, OrgStatus newStatus, string calldata reason)
        external onlyOwner
    {
        if (!organizations[wallet].exists) revert OrgNotFound(wallet);
        OrgStatus old = organizations[wallet].status;
        organizations[wallet].status    = newStatus;
        organizations[wallet].updatedAt = block.timestamp;
        emit OrganizationStatusChanged(wallet, old, newStatus, reason);
    }

    function updateOrganizationName(address wallet, string calldata newName) external onlyOwner {
        if (!organizations[wallet].exists) revert OrgNotFound(wallet);
        organizations[wallet].name      = newName;
        organizations[wallet].updatedAt = block.timestamp;
    }

    function removeOrganization(address wallet, string calldata reason) external onlyOwner {
        if (!organizations[wallet].exists) revert OrgNotFound(wallet);
        for (uint256 i = 0; i < orgList.length; i++) {
            if (orgList[i] == wallet) { orgList[i] = orgList[orgList.length - 1]; orgList.pop(); break; }
        }
        delete organizations[wallet];
        emit OrganizationRemoved(wallet, reason);
    }

    function registerGateway(bytes calldata publicKey, address orgWallet, string calldata name)
        external onlyOwner
    {
        if (publicKey.length == 0) revert InvalidPublicKey();
        if (!organizations[orgWallet].exists) revert OrgNotFound(orgWallet);
        if (gateways[publicKey].exists)  revert GatewayAlreadyExists(publicKey);

        gateways[publicKey] = Gateway({
            publicKey:    publicKey,
            orgWallet:    orgWallet,
            name:         name,
            status:       GatewayStatus.Active,
            registeredAt: block.timestamp,
            updatedAt:    block.timestamp,
            exists:       true
        });
        orgGateways[orgWallet].push(publicKey);
        gatewayList.push(publicKey);
        emit GatewayRegistered(publicKey, orgWallet, block.timestamp);
    }

    function setGatewayStatus(bytes calldata publicKey, GatewayStatus newStatus, string calldata reason)
        external onlyOwner
    {
        if (!gateways[publicKey].exists) revert GatewayNotFound(publicKey);
        GatewayStatus old = gateways[publicKey].status;
        gateways[publicKey].status    = newStatus;
        gateways[publicKey].updatedAt = block.timestamp;
        emit GatewayStatusChanged(publicKey, old, newStatus, reason);
    }

    function removeGateway(bytes calldata publicKey, string calldata reason) external onlyOwner {
        if (!gateways[publicKey].exists) revert GatewayNotFound(publicKey);
        address orgWallet = gateways[publicKey].orgWallet;
        bytes[] storage og = orgGateways[orgWallet];
        for (uint256 i = 0; i < og.length; i++) {
            if (keccak256(og[i]) == keccak256(publicKey)) {
                og[i] = og[og.length - 1];
                og.pop();
                break;
            }
        }
        for (uint256 i = 0; i < gatewayList.length; i++) {
            if (keccak256(gatewayList[i]) == keccak256(publicKey)) {
                gatewayList[i] = gatewayList[gatewayList.length - 1];
                gatewayList.pop();
                break;
            }
        }
        delete gateways[publicKey];
        emit GatewayRemoved(publicKey, reason);
    }

    function setReputation(address wallet, uint256 newRep) external onlyOwner {
        if (!organizations[wallet].exists) revert OrgNotFound(wallet);
        if (newRep > MAX_REPUTATION) revert ReputationOutOfRange(newRep, MAX_REPUTATION);
        organizations[wallet].reputation = newRep;        
        organizations[wallet].updatedAt  = block.timestamp;
        _takeSnapshot(wallet);                            
    }

    function increaseReputation(address wallet, uint256 amount) external onlyOwner {
        if (!organizations[wallet].exists) revert OrgNotFound(wallet);
        uint256 old  = organizations[wallet].reputation;
        uint256 next = old + amount > MAX_REPUTATION ? MAX_REPUTATION : old + amount;
        organizations[wallet].reputation = next;           
        organizations[wallet].updatedAt  = block.timestamp;
        _takeSnapshot(wallet);                             
    }

    function decreaseReputation(address wallet, uint256 amount) external onlyOwner {
        if (!organizations[wallet].exists) revert OrgNotFound(wallet);
        uint256 old  = organizations[wallet].reputation;
        uint256 next = old < amount ? 0 : old - amount;
        organizations[wallet].reputation = next;           
        organizations[wallet].updatedAt  = block.timestamp;
        _takeSnapshot(wallet);                             
    }

    function _takeSnapshot(address wallet) internal {
        uint256[] storage blocks = _snapshotBlocks[wallet];
        if (blocks.length == 0 || blocks[blocks.length - 1] < block.number) {
            blocks.push(block.number);
            _reputationSnapshots[wallet][block.number] = organizations[wallet].reputation;
        }
    }

    function getReputationAt(address wallet, uint256 blockNumber) external view returns (uint256) {
        uint256[] storage blocks = _snapshotBlocks[wallet];

        if (blocks.length == 0)           return organizations[wallet].reputation;
        if (blockNumber < blocks[0])      return 0;

        uint256 low = 0; uint256 high = blocks.length - 1;
        while (low < high) {
            uint256 mid = (low + high + 1) / 2;
            if (blocks[mid] <= blockNumber) low = mid;
            else high = mid - 1;
        }
        return _reputationSnapshots[wallet][blocks[low]];
    }

    function getOrganization(address wallet) external view returns (Organization memory) {
        if (!organizations[wallet].exists) revert OrgNotFound(wallet);
        return organizations[wallet];
    }

    function getGateway(bytes calldata publicKey) external view returns (Gateway memory) {
        if (!gateways[publicKey].exists) revert GatewayNotFound(publicKey);
        return gateways[publicKey];
    }

    function getOrgGateways(address orgWallet) external view returns (bytes[] memory) {
        return orgGateways[orgWallet];
    }

    function getOrgCount()     external view returns (uint256) { return orgList.length; }
    function getGatewayCount() external view returns (uint256) { return gatewayList.length; }

    function isOrgActive(address wallet) external view returns (bool) {
        return organizations[wallet].exists && organizations[wallet].status == OrgStatus.Active;
    }

    function isGatewayActive(bytes calldata publicKey) external view returns (bool) {
        return gateways[publicKey].exists && gateways[publicKey].status == GatewayStatus.Active;
    }

    function getOrgsByStatus(OrgStatus status) external view returns (address[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < orgList.length; i++)
            if (organizations[orgList[i]].status == status) count++;
        address[] memory result = new address[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < orgList.length; i++)
            if (organizations[orgList[i]].status == status) result[idx++] = orgList[i];
        return result;
    }

    function getAllOrganizations() external view returns (Organization[] memory) {
        Organization[] memory all = new Organization[](orgList.length);
        for (uint256 i = 0; i < orgList.length; i++) {
            all[i] = organizations[orgList[i]];
        }
        return all;
    }

    function getAllGateways() external view returns (Gateway[] memory) {
        Gateway[] memory all = new Gateway[](gatewayList.length);
        for (uint256 i = 0; i < gatewayList.length; i++) {
            all[i] = gateways[gatewayList[i]];
        }
        return all;
    }
}