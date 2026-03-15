import '@nomicfoundation/hardhat-viem';
import * as fs from 'fs';
import * as path from 'path';
import hre from 'hardhat';

/**
 * Upgrade DealerNFT implementation via UUPS proxy pattern.
 * - Deploys new DealerNFT implementation
 * - Calls upgradeToAndCall on the existing proxy
 * - Sets default permissions (SPORTS category=1, all subcategories=[0xFF])
 * - Updates DEPLOYED.json with new implementation address
 */
async function main() {
  const { viem, network } = hre;

  const deploymentsPath = path.join(process.cwd(), 'DEPLOYED.json');
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error('DEPLOYED.json not found. Run deploy first.');
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'));
  const networkDeployment = deployments.networks[network.name];
  if (!networkDeployment) {
    throw new Error(`No deployment found for network: ${network.name}`);
  }

  const proxyAddress = networkDeployment.dealerNFT.proxy as `0x${string}`;
  const oldImpl = networkDeployment.dealerNFT.implementation;

  const [deployer] = await viem.getWalletClients();
  console.log('⬆️  Upgrading DealerNFT on', network.name);
  console.log('👤 Deployer:', deployer.account.address);
  console.log('📋 Proxy:', proxyAddress);
  console.log('📋 Old implementation:', oldImpl);

  // 1. Deploy new implementation
  const newImpl = await viem.deployContract('DealerNFT');
  console.log('🆕 New implementation:', newImpl.address);

  // 2. Upgrade proxy to new implementation
  const dealerNFT = await viem.getContractAt('DealerNFT', proxyAddress);
  await dealerNFT.write.upgradeToAndCall([newImpl.address, '0x'], {
    account: deployer.account,
  });
  console.log('✅ Proxy upgraded to new implementation');

  // 3. Set default permissions: SPORTS category (1) with all subcategories (0xFF)
  await dealerNFT.write.setDefaultPermissions([1n, [0xFFn]], {
    account: deployer.account,
  });
  console.log('🏷️  Default permissions set: category=1 (SPORTS), subcategories=[0xFF] (all)');

  // 4. Update DEPLOYED.json
  networkDeployment.dealerNFT.implementation = newImpl.address;
  networkDeployment.dealerNFT.upgradedAt = new Date().toISOString();
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log('💾 DEPLOYED.json updated');

  console.log('\n🎉 DealerNFT upgrade complete!');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
