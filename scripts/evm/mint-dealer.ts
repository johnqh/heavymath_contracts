import '@nomicfoundation/hardhat-viem';
import hre from 'hardhat';

async function main() {
  const { viem } = hre;
  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const dealerNFT = await viem.getContractAt('DealerNFT', '0x62d545189b5caa014de27787f3d996e10c437e35');

  // Set mint price to 0 (we're the owner)
  console.log('Setting mint price to 0...');
  const priceHash = await dealerNFT.write.setMintPrice([0n], { account: deployer.account });
  await publicClient.waitForTransactionReceipt({ hash: priceHash });
  console.log('Mint price set to 0');

  // Mint NFT (free now)
  console.log('Minting Dealer NFT...');
  const mintHash = await dealerNFT.write.mint({ account: deployer.account });
  console.log('Mint tx:', mintHash);
  const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintHash });
  console.log('Mint confirmed, block:', mintReceipt.blockNumber);

  // Check balance
  const balance = await dealerNFT.read.balanceOf([deployer.account.address]);
  console.log('NFT balance:', balance.toString());

  // Get token ID (should be 0 for first mint)
  const tokenId = await dealerNFT.read.tokenOfOwnerByIndex([deployer.account.address, 0n]);
  console.log('Token ID:', tokenId.toString());

  // Grant wildcard permissions (0xFF for category, 0xFF for subcategory)
  console.log('Setting wildcard permissions...');
  const permHash = await dealerNFT.write.setPermissions([tokenId, 255n, [255n]], { account: deployer.account });
  console.log('Permission tx:', permHash);
  const permReceipt = await publicClient.waitForTransactionReceipt({ hash: permHash });
  console.log('Permissions set, block:', permReceipt.blockNumber);

  // Verify
  const hasPerm = await dealerNFT.read.hasPermissions([tokenId]);
  console.log('Has permissions:', hasPerm);
  const valid = await dealerNFT.read.validatePermission([tokenId, 1n, 1n]);
  console.log('Validates for SPORTS/soccer:', valid);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
