import '@nomicfoundation/hardhat-viem';
import * as fs from 'fs';
import * as path from 'path';
import hre from 'hardhat';
import { encodeFunctionData, parseAbi, parseEther } from 'viem';

async function main() {
  const { viem, network } = hre;
  const usdcAddress = process.env.USDC_ADDRESS;
  if (!usdcAddress) {
    throw new Error('USDC_ADDRESS env var is required for deployment');
  }
  const ownerMultisig = process.env.OWNER_MULTISIG;

  const [deployer] = await viem.getWalletClients();
  console.log('🚀 Deploying to', network.name);
  console.log('👤 Deployer:', deployer.account.address);
  console.log('💰 Stake token (USDC):', usdcAddress);

  const dealerNFTImpl = await viem.deployContract('DealerNFT');
  const dealerNFTInitData = encodeFunctionData({
    abi: parseAbi(['function initialize(uint256)']),
    functionName: 'initialize',
    args: [parseEther('0.05')],
  });
  const dealerNFTProxy = await viem.deployContract('ERC1967Proxy', [
    dealerNFTImpl.address,
    dealerNFTInitData,
  ]);
  const dealerNFT = await viem.getContractAt('DealerNFT', dealerNFTProxy.address);
  console.log('🏷️  DealerNFT proxy:', dealerNFTProxy.address);

  const oracleImpl = await viem.deployContract('OracleResolver');
  const oracleInitData = encodeFunctionData({
    abi: parseAbi(['function initialize()']),
    functionName: 'initialize',
    args: [],
  });
  const oracleProxy = await viem.deployContract('ERC1967Proxy', [
    oracleImpl.address,
    oracleInitData,
  ]);
  const oracleResolver = await viem.getContractAt('OracleResolver', oracleProxy.address);
  console.log('🔮 OracleResolver proxy:', oracleProxy.address);

  const predictionImpl = await viem.deployContract('PredictionMarket');
  const predictionInitData = encodeFunctionData({
    abi: parseAbi(['function initialize(address,address,address)']),
    functionName: 'initialize',
    args: [dealerNFTProxy.address, oracleProxy.address, usdcAddress as `0x${string}`],
  });
  const predictionProxy = await viem.deployContract('ERC1967Proxy', [
    predictionImpl.address,
    predictionInitData,
  ]);
  const predictionMarket = await viem.getContractAt('PredictionMarket', predictionProxy.address);
  console.log('📈 PredictionMarket proxy:', predictionProxy.address);

  // Register PredictionMarket as authorized caller on OracleResolver
  await oracleResolver.write.setPredictionMarket([predictionProxy.address]);
  console.log('🔗 OracleResolver.setPredictionMarket set to PredictionMarket');

  const newOwner = ownerMultisig ?? deployer.account.address;
  if (ownerMultisig) {
    console.log('🔑 Transferring ownership to', ownerMultisig);
  } else {
    console.log('⚠️ OWNER_MULTISIG not set, keeping deployer as owner');
  }
  if (ownerMultisig) {
    await dealerNFT.write.transferOwnership([ownerMultisig], {
      account: deployer.account,
    });
    await oracleResolver.write.transferOwnership([ownerMultisig], {
      account: deployer.account,
    });
    await predictionMarket.write.transferOwnership([ownerMultisig], {
      account: deployer.account,
    });
  }

  const deploymentsPath = path.join(process.cwd(), 'DEPLOYED.json');
  const deployments = fs.existsSync(deploymentsPath)
    ? JSON.parse(fs.readFileSync(deploymentsPath, 'utf-8'))
    : { description: 'Deployment addresses for HeavyMath Prediction Market contracts across different networks', networks: {} };

  deployments.networks[network.name] = {
    deployedAt: new Date().toISOString(),
    deployer: deployer.account.address,
    stakeToken: usdcAddress,
    owner: newOwner,
    dealerNFT: {
      implementation: dealerNFTImpl.address,
      proxy: dealerNFTProxy.address,
    },
    oracleResolver: {
      implementation: oracleImpl.address,
      proxy: oracleProxy.address,
    },
    predictionMarket: {
      implementation: predictionImpl.address,
      proxy: predictionProxy.address,
    },
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log('✅ Deployment information saved to DEPLOYED.json');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
