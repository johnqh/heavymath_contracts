import '@nomicfoundation/hardhat-viem';
import hre from 'hardhat';

async function main() {
  const { viem } = hre;
  const dealerNFT = await viem.getContractAt(
    'DealerNFT',
    '0x62d545189b5caa014de27787f3d996e10c437e35'
  );

  const owner = await dealerNFT.read.ownerOf([1n]);
  console.log('Token 1 owner:', owner);

  const hasPerm = await dealerNFT.read.hasPermissions([1n]);
  console.log('Has permissions:', hasPerm);

  const valid = await dealerNFT.read.validatePermission([1n, 1n, 1n]);
  console.log('Validates for SPORTS/soccer:', valid);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
