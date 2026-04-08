import '@nomicfoundation/hardhat-viem';
import hre from 'hardhat';

async function main() {
  const { viem } = hre;
  const oracleResolver = await viem.getContractAt(
    'OracleResolver',
    '0xa926f2087c7fa88542674fd75204d3c6e146d9d2'
  );

  console.log('Configuring Chainlink on OracleResolver...');

  const hash = await oracleResolver.write.setChainlinkConfig([
    '0x779877A7B0D9E8603169DdbD7836e478b4624789', // LINK token (Sepolia)
    '0x0FaCf846af22BCE1C7f88D1d55A038F27747eD2B', // LinkWell Nodes operator
    '0xa8356f48569c434eaa4ac5fcb4db5cc000000000000000000000000000000000', // Job ID
    0n, // Fee (0 LINK on testnet)
    'https://idx.heavymath.com/api/markets/', // Indexer resolve endpoint
  ]);
  console.log('setChainlinkConfig tx:', hash);

  const publicClient = await viem.getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('Confirmed in block:', receipt.blockNumber);
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
