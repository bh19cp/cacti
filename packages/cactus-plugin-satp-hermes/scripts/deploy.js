const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)), "ETH\n");

  console.log("Deploying Token...");
  const Token = await ethers.getContractFactory("Token");
  const token = await Token.deploy(
    "TestDao",
    "RDAO",
    1000000,
    deployer.address
  );
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("  Token:", tokenAddr);


  console.log("Deploying GatewayRegistry...");
  const GatewayRegistry = await ethers.getContractFactory("GatewayRegistry");
  const registry = await GatewayRegistry.deploy(deployer.address);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("  GatewayRegistry:", registryAddr);

  console.log("Deploying PolicyRegistry...");
  const PolicyRegistry = await ethers.getContractFactory("PolicyRegistry");
  const policy = await PolicyRegistry.deploy(deployer.address);
  await policy.waitForDeployment();
  const policyAddr = await policy.getAddress();
  console.log("  PolicyRegistry:", policyAddr);

  console.log("\nRegistering organizations...");
  const tokensPerMember = ethers.parseEther("1000");

  await registry.registerOrganization("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "Organization A", 0);
  await token.transfer("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", tokensPerMember);
  console.log("  Registered: Organization A (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)");

  await registry.registerGateway("0x02e68acfc0253a10620dff079256c9efb7df3a7eb5b4dc8d03aefc3cbd5c20a1b0", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","GatewayA1");
  console.log("    Gateway registered: 0x02e68acfc0253a10620dff079256c9efb7df3a7eb5b4dc8d03aefc3cbd5c20a1b0 for Organization A");
  await registry.registerGateway("0x03b17e6b5f7b87e2b0ef3e1c4d942f19a8d1f5e3c9b4872e3e9e3e3e3e3e3e3e", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266","GatewayA2");
  console.log("    Gateway registered: 0x03b17e6b5f7b87e2b0ef3e1c4d942f19a8d1f5e3c9b4872e3e9e3e3e3e3e3e3e for Organization A");
  await registry.registerOrganization("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "Organization B", 0);
  await token.transfer("0x70997970C51812dc3A010C7d01b50e0d17dc79C8", tokensPerMember);
  console.log("  Registered: Organization B (0x70997970C51812dc3A010C7d01b50e0d17dc79C8)");

  await registry.registerGateway("0x027a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8","GatewayB1");
  console.log("    Gateway registered: 0x027a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef for Organization B");
  await registry.registerOrganization("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "Organization C", 0);
  await token.transfer("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", tokensPerMember);
  console.log("  Registered: Organization C (0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC)");

  await registry.registerGateway("0x03f123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","GatewayC1");
  console.log("    Gateway registered: 0x03f123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd for Organization C");

  console.log("\nAdding protocol parameters...");
  // satp.version = v02 (encoded as 98261859107505352197975460147859908948951633040597383920932402284373959241046)
  await policy.addParameter("satp.version", 98261859107505352197975460147859908948951633040597383920932402284373959241046n);
  // satp.crash.version = v02 (encoded as 98261859107505352197975460147859908948951633040597383920932402284373959241046)
  await policy.addParameter("satp.crash.version", 98261859107505352197975460147859908948951633040597383920932402284373959241046n);
  // satp.session.lockExpirationTime = 34 (encoded as 34)
  await policy.addParameter("satp.session.lockExpirationTime", 34n);
  // signingAlgorithm = SECP256K1 (encoded as 62373828172641644480387627413073753205438289683356566628901328960662664083539)
  await policy.addParameter("signingAlgorithm", 62373828172641644480387627413073753205438289683356566628901328960662664083539n);
  // claimFormat = 3 (encoded as 3)
  await policy.addParameter("claimFormat", 3n);

  const remaining = await token.balanceOf(deployer.address);
  console.warn("  Warning: No timelock configured; treasury remains with deployer.");

  console.log("isWeightedReputation:", false);

  console.log("\nDeploying Governance...");
  const Governor = await ethers.getContractFactory("Governance");
  const governor = await Governor.deploy(
    "TestDao",
    tokenAddr,
    
    1,
    5,
    0,
    0,
    0,
    ethers.ZeroAddress
  );
  await governor.waitForDeployment();
  const governorAddr = await governor.getAddress();
  console.log("  Governance:", governorAddr);

  await registry.transferOwnership(governorAddr);
  await policy.transferOwnership(governorAddr);
  await token.transferOwnership(governorAddr);
  console.log("  Ownership transferred directly to governor (no timelock).");
  console.log("\nDeployment summary:");
  console.log("  Token:           ", tokenAddr);
  console.log("  GatewayRegistry: ", registryAddr);
  console.log("  PolicyRegistry:  ", policyAddr);
  console.log("  Governor:        ", governorAddr);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});