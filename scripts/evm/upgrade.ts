import '@nomicfoundation/hardhat-viem';
import * as fs from 'fs';
import * as path from 'path';
import hre from 'hardhat';

/**
 * UUPS upgrade script for PredictionMarket, DealerNFT, and/or OracleResolver.
 *
 * Usage:
 *   UPGRADE=PredictionMarket bun run upgrade:evm:sepolia
 *   UPGRADE=PredictionMarket,DealerNFT bun run upgrade:evm:sepolia
 *
 * Reads proxy addresses from DEPLOYED.json, deploys new implementations,
 * and calls upgradeToAndCall on each proxy.
 */
async function main() {
  const { viem, network } = hre;
  const networkName = network.name;

  const upgradeList = (process.env.UPGRADE || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (upgradeList.length === 0) {
    throw new Error(
      'UPGRADE env var is required. Set to comma-separated contract names, e.g. UPGRADE=PredictionMarket'
    );
  }

  const validContracts = ['PredictionMarket', 'DealerNFT', 'OracleResolver'] as const;
  for (const name of upgradeList) {
    if (!validContracts.includes(name as (typeof validContracts)[number])) {
      throw new Error(`Unknown contract: ${name}. Valid: ${validContracts.join(', ')}`);
    }
  }

  // Load DEPLOYED.json
  const deploymentsPath = path.join(process.cwd(), 'DEPLOYED.json');
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error('DEPLOYED.json not found. Deploy first with bun run deploy:evm:sepolia');
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'));
  const networkDeployment = deployments.networks[networkName];
  if (!networkDeployment) {
    throw new Error(`No deployment found for network "${networkName}" in DEPLOYED.json`);
  }

  const [deployer] = await viem.getWalletClients();
  console.log(`⬆️  Upgrading on ${networkName}`);
  console.log(`👤 Deployer: ${deployer.account.address}`);
  console.log(`📦 Contracts to upgrade: ${upgradeList.join(', ')}`);

  const contractKeyMap: Record<string, string> = {
    PredictionMarket: 'predictionMarket',
    DealerNFT: 'dealerNFT',
    OracleResolver: 'oracleResolver',
  };

  for (const contractName of upgradeList) {
    const key = contractKeyMap[contractName];
    const entry = networkDeployment[key];
    if (!entry?.proxy) {
      throw new Error(`No proxy address found for ${contractName} in DEPLOYED.json`);
    }

    const proxyAddress = entry.proxy as `0x${string}`;
    console.log(`\n--- Upgrading ${contractName} ---`);
    console.log(`  Proxy: ${proxyAddress}`);
    console.log(`  Old impl: ${entry.implementation}`);

    // Deploy new implementation
    const newImpl = await viem.deployContract(contractName as 'PredictionMarket');
    console.log(`  New impl: ${newImpl.address}`);

    // Call upgradeToAndCall on the proxy (UUPS - the function lives on the implementation)
    const proxy = await viem.getContractAt(contractName as 'PredictionMarket', proxyAddress);
    const hash = await proxy.write.upgradeToAndCall([newImpl.address, '0x'], {
      account: deployer.account,
    });
    console.log(`  Upgrade tx: ${hash}`);

    // Wait for confirmation
    const publicClient = await viem.getPublicClient();
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  Confirmed in block: ${receipt.blockNumber}`);

    // Update DEPLOYED.json
    entry.implementation = newImpl.address;
    entry.upgradedAt = new Date().toISOString();
  }

  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log('\n✅ DEPLOYED.json updated with new implementation addresses');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
