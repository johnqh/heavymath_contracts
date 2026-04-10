import '@nomicfoundation/hardhat-viem';
import hre from 'hardhat';
import { formatEther } from 'viem';

async function main() {
  const { viem } = hre;

  const oracleResolver = await viem.getContractAt(
    'OracleResolver',
    '0xa926f2087c7fa88542674fd75204d3c6e146d9d2'
  );
  const predictionMarket = await viem.getContractAt(
    'PredictionMarket',
    '0x409464d2e712ffc7e64baa191cac65c731581f05'
  );

  console.log('=== Oracle Setup Verification ===\n');

  // Step 1: Chainlink config
  const chainlinkOracle = await oracleResolver.read.chainlinkOracle();
  const apiBaseUrl = await oracleResolver.read.apiBaseUrl();
  const chainlinkJobId = await oracleResolver.read.chainlinkJobId();
  const chainlinkFee = await oracleResolver.read.chainlinkFee();
  const zero = '0x0000000000000000000000000000000000000000';

  console.log('Step 1: Chainlink Config');
  console.log('  Oracle address:', chainlinkOracle);
  console.log('  Job ID:', chainlinkJobId);
  console.log('  Fee:', chainlinkFee.toString());
  console.log('  API Base URL:', apiBaseUrl);
  const step1Ok = chainlinkOracle !== zero && apiBaseUrl.length > 0;
  console.log('  Status:', step1Ok ? '✅ CONFIGURED' : '❌ NOT CONFIGURED');

  // Step 2: PredictionMarket set
  const pmAddress = await oracleResolver.read.predictionMarket();
  console.log('\nStep 2: PredictionMarket');
  console.log('  Address:', pmAddress);
  const step2Ok = pmAddress !== zero;
  console.log(
    '  Matches expected:',
    pmAddress.toLowerCase() === '0x409464d2e712ffc7e64baa191cac65c731581f05'
  );
  console.log('  Status:', step2Ok ? '✅ CONFIGURED' : '❌ NOT CONFIGURED');

  // Step 3: LINK balance
  const publicClient = await viem.getPublicClient();
  const linkToken = '0x779877A7B0D9E8603169DdbD7836e478b4624789';
  const linkAbi = [
    {
      name: 'balanceOf',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ] as const;
  const balance = await publicClient.readContract({
    address: linkToken,
    abi: linkAbi,
    functionName: 'balanceOf',
    args: ['0xa926f2087c7fa88542674fd75204d3c6e146d9d2'],
  });
  console.log('\nStep 3: LINK Funding');
  console.log('  Balance:', formatEther(balance), 'LINK');
  const step3Ok = balance > 0n;
  console.log('  Status:', step3Ok ? '✅ FUNDED' : '❌ NOT FUNDED');

  // Bonus: check contract owners
  const pmOwner = await predictionMarket.read.owner();
  const orOwner = await oracleResolver.read.owner();
  console.log('\nOwnership:');
  console.log('  PredictionMarket owner:', pmOwner);
  console.log('  OracleResolver owner:', orOwner);
  console.log(
    '  Same owner:',
    pmOwner.toLowerCase() === orOwner.toLowerCase() ? '✅' : '⚠️ DIFFERENT'
  );

  console.log('\n=== Overall ===');
  if (step1Ok && step2Ok && step3Ok) {
    console.log('✅ All 3 steps completed. Oracle resolution is ready.');
  } else {
    console.log('❌ Setup incomplete.');
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
