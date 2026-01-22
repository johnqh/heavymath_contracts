import type { Abi, Address, Chain, Hash, PublicClient, WalletClient } from "viem";
import { erc20Abi, getAddress } from "viem";
import { PredictionMarket__factory } from "../../typechain-types/factories/contracts/PredictionMarket__factory";

// Export TypeChain types for production contracts
export { PredictionMarket__factory } from "../../typechain-types/factories/contracts/PredictionMarket__factory";
export type { PredictionMarket } from "../../typechain-types/contracts/PredictionMarket";

const PREDICTION_MARKET_ABI = PredictionMarket__factory.abi as Abi;

export interface WalletContext {
  walletClient: WalletClient;
  publicClient?: PublicClient;
  chain?: Chain;
}

export interface ContractAddresses {
  predictionMarket: Address;
  stakeToken?: Address;
}

export interface TransactionResult {
  hash: Hash;
  receiptHash?: Hash;
}

export interface CreateMarketParams {
  tokenId: bigint;
  category: bigint;
  subCategory: bigint;
  deadline: bigint;
  description: string;
  oracleId?: Address | `0x${string}`;
}

export class EVMPredictionClient {
  private readonly abi: Abi;
  private readonly addresses: ContractAddresses;
  private stakeTokenCache?: Address;

  constructor(addresses: ContractAddresses) {
    this.addresses = addresses;
    this.abi = PREDICTION_MARKET_ABI;
  }

  private predictionMarketAddress(): Address {
    return this.addresses.predictionMarket;
  }

  private ensureAccount(wallet: WalletContext): Address {
    const account = wallet.walletClient.account?.address;
    if (!account) {
      throw new Error("Wallet client is not configured with an account");
    }
    return getAddress(account);
  }

  private getPublicClient(wallet: WalletContext): PublicClient {
    if (wallet.publicClient) {
      return wallet.publicClient;
    }
    throw new Error(
      "A viem PublicClient is required for this operation. Provide wallet.publicClient."
    );
  }

  private async resolveStakeToken(wallet: WalletContext): Promise<Address> {
    if (this.addresses.stakeToken) {
      return getAddress(this.addresses.stakeToken);
    }
    if (this.stakeTokenCache) {
      return this.stakeTokenCache;
    }
    const publicClient = this.getPublicClient(wallet);
    const address = (await publicClient.readContract({
      address: this.predictionMarketAddress(),
      abi: this.abi,
      functionName: "stakeToken",
    })) as Address;
    this.stakeTokenCache = getAddress(address);
    return this.stakeTokenCache;
  }

  private async ensureAllowance(
    wallet: WalletContext,
    amount: bigint
  ): Promise<void> {
    if (amount === 0n) {
      return;
    }
    const token = await this.resolveStakeToken(wallet);
    const owner = this.ensureAccount(wallet);
    const spender = this.predictionMarketAddress();
    const publicClient = this.getPublicClient(wallet);
    const currentAllowance = (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    })) as bigint;
    if (currentAllowance >= amount) {
      return;
    }
    await wallet.walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
      chain: wallet.chain || null,
      account: wallet.walletClient.account || null,
    });
  }

  private async execute(
    wallet: WalletContext,
    functionName: string,
    args: readonly unknown[]
  ): Promise<TransactionResult> {
    const hash = await wallet.walletClient.writeContract({
      address: this.predictionMarketAddress(),
      abi: this.abi,
      functionName,
      args,
      chain: wallet.chain || null,
      account: wallet.walletClient.account || null,
    });

    if (wallet.publicClient) {
      const receipt = await wallet.publicClient.waitForTransactionReceipt({
        hash,
      });
      return { hash, receiptHash: receipt.transactionHash };
    }
    return { hash };
  }

  async createMarket(
    wallet: WalletContext,
    params: CreateMarketParams
  ): Promise<TransactionResult> {
    const oracle =
      params.oracleId ??
      "0x0000000000000000000000000000000000000000000000000000000000000000";
    return this.execute(wallet, "createMarket", [
      params.tokenId,
      params.category,
      params.subCategory,
      params.deadline,
      params.description,
      oracle,
    ]);
  }

  async setDealerFee(
    wallet: WalletContext,
    marketId: bigint,
    feeBps: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "setDealerFee", [marketId, feeBps]);
  }

  async placePrediction(
    wallet: WalletContext,
    marketId: bigint,
    percentage: number,
    amount: bigint
  ): Promise<TransactionResult> {
    await this.ensureAllowance(wallet, amount);
    return this.execute(wallet, "placePrediction", [
      marketId,
      BigInt(percentage),
      amount,
    ]);
  }

  async updatePrediction(
    wallet: WalletContext,
    marketId: bigint,
    newPercentage: number,
    additionalAmount: bigint
  ): Promise<TransactionResult> {
    if (additionalAmount > 0n) {
      await this.ensureAllowance(wallet, additionalAmount);
    }
    return this.execute(wallet, "updatePrediction", [
      marketId,
      BigInt(newPercentage),
      additionalAmount,
    ]);
  }

  async withdrawPrediction(
    wallet: WalletContext,
    marketId: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "withdrawPrediction", [marketId]);
  }

  async cancelMarket(
    wallet: WalletContext,
    marketId: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "cancelMarket", [marketId]);
  }

  async abandonMarket(
    wallet: WalletContext,
    marketId: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "abandonMarket", [marketId]);
  }

  async resolveMarket(
    wallet: WalletContext,
    marketId: bigint,
    resolution: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "resolveMarket", [marketId, resolution]);
  }

  async resolveMarketWithOracle(
    wallet: WalletContext,
    marketId: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "resolveMarketWithOracle", [marketId]);
  }

  async claimWinnings(
    wallet: WalletContext,
    marketId: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "claimWinnings", [marketId]);
  }

  async claimRefund(
    wallet: WalletContext,
    marketId: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "claimRefund", [marketId]);
  }

  async withdrawDealerFees(
    wallet: WalletContext,
    marketId: bigint
  ): Promise<TransactionResult> {
    return this.execute(wallet, "withdrawDealerFees", [marketId]);
  }

  async withdrawSystemFees(
    wallet: WalletContext
  ): Promise<TransactionResult> {
    return this.execute(wallet, "withdrawSystemFees", []);
  }

  async getMarket(
    publicClient: PublicClient,
    marketId: bigint
  ): Promise<ReturnType<typeof formatMarket>> {
    const raw = await publicClient.readContract({
      address: this.predictionMarketAddress(),
      abi: this.abi,
      functionName: "markets",
      args: [marketId],
    });
    return formatMarket(raw as readonly unknown[]);
  }

  async getPrediction(
    publicClient: PublicClient,
    marketId: bigint,
    account: Address
  ) {
    const raw = (await publicClient.readContract({
      address: this.predictionMarketAddress(),
      abi: this.abi,
      functionName: "predictions",
      args: [marketId, account],
    })) as readonly [bigint, bigint, bigint, boolean];
    return {
      amount: BigInt(raw[0]),
      percentage: BigInt(raw[1]),
      placedAt: BigInt(raw[2]),
      claimed: Boolean(raw[3]),
    };
  }
}

function formatMarket(raw: readonly unknown[]) {
  return {
    dealer: getAddress(raw[0] as string),
    tokenId: BigInt(raw[1] as bigint),
    category: BigInt(raw[2] as bigint),
    subCategory: BigInt(raw[3] as bigint),
    deadline: BigInt(raw[4] as bigint),
    description: raw[5] as string,
    createdAt: BigInt(raw[6] as bigint),
    dealerFeeBps: BigInt(raw[7] as bigint),
    status: Number(raw[8] as number),
    resolution: BigInt(raw[9] as bigint),
    equilibrium: BigInt(raw[10] as bigint),
    oracleId: raw[11] as `0x${string}`,
  };
}

export type MarketState = ReturnType<typeof formatMarket>;
