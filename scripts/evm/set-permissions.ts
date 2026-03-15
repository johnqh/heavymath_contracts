import '@nomicfoundation/hardhat-viem';
import hre from 'hardhat';

async function main() {
  const { viem } = hre;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const dealerNFT = await viem.getContractAt('DealerNFT', '0x62d545189b5caa014de27787f3d996e10c437e35');

  console.log('Setting wildcard permissions for token 1...');
  const hash = await dealerNFT.write.setPermissions([1n, 255n, [255n]], { account: deployer.account });
  console.log('Tx:', hash);
  await publicClient.waitForTransactionReceipt({ hash });

  const valid = await dealerNFT.read.validatePermission([1n, 1n, 1n]);
  console.log('Validates for SPORTS/soccer:', valid);
  console.log('Done!');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
