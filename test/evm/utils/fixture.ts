import hre from "hardhat";
import { encodeFunctionData, parseAbi, parseUnits } from "viem";

const { viem, network } = hre;

export const USDC_DECIMALS = 6;
export const toUSDC = (value: string) => parseUnits(value, USDC_DECIMALS);

export async function deployPredictionFixture() {
  const [owner, dealer1, dealer2, predictor1, predictor2, predictor3] =
    await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const dealerNFTImpl = await viem.deployContract("DealerNFT");
  const dealerNFTInitData = encodeFunctionData({
    abi: parseAbi(["function initialize()"]),
    functionName: "initialize",
    args: [],
  });
  const dealerNFTProxy = await viem.deployContract("ERC1967Proxy", [
    dealerNFTImpl.address,
    dealerNFTInitData,
  ]);
  const dealerNFT = await viem.getContractAt("DealerNFT", dealerNFTProxy.address);
  await dealerNFT.write.mint([dealer1.account.address, 1n]);
  await dealerNFT.write.mint([dealer2.account.address, 2n]);
  await dealerNFT.write.setPermissions([1n, 1n, [0xFFn]]);
  await dealerNFT.write.setPermissions([2n, 1n, [1n, 2n]]);

  const oracleImpl = await viem.deployContract("OracleResolver");
  const oracleInitData = encodeFunctionData({
    abi: parseAbi(["function initialize()"]),
    functionName: "initialize",
    args: [],
  });
  const oracleProxy = await viem.deployContract("ERC1967Proxy", [
    oracleImpl.address,
    oracleInitData,
  ]);
  const oracleResolver = await viem.getContractAt(
    "OracleResolver",
    oracleProxy.address
  );

  const stakeToken = await viem.deployContract("MockUSDC");

  const marketImpl = await viem.deployContract("PredictionMarket");
  const marketInitData = encodeFunctionData({
    abi: parseAbi(["function initialize(address,address,address)"]),
    functionName: "initialize",
    args: [dealerNFT.address, oracleResolver.address, stakeToken.address],
  });
  const marketProxy = await viem.deployContract("ERC1967Proxy", [
    marketImpl.address,
    marketInitData,
  ]);
  const market = await viem.getContractAt("PredictionMarket", marketProxy.address);

  const initialBalance = toUSDC("100000");
  const wallets = [dealer1, dealer2, predictor1, predictor2, predictor3];
  for (const wallet of wallets) {
    await stakeToken.write.mint([wallet.account.address, initialBalance], {
      account: owner.account,
    });
    await stakeToken.write.approve([market.address, initialBalance], {
      account: wallet.account,
    });
  }

  return {
    market,
    dealerNFT,
    oracleResolver,
    stakeToken,
    owner,
    dealer1,
    dealer2,
    predictor1,
    predictor2,
    predictor3,
    publicClient,
  };
}

export async function advanceTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}
