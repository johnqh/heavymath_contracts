import {
  EVMPredictionClient,
  type ContractAddresses,
  type WalletContext,
  type TransactionResult,
  type CreateMarketParams,
  type MarketState,
} from "../evm";

/**
 * Unified prediction client
 * - Provides typed access to the EVM prediction client
 * - Placeholder for future Solana integration
 */
export class PredictionClient {
  readonly evm: EVMPredictionClient;

  constructor(addresses: ContractAddresses) {
    this.evm = new EVMPredictionClient(addresses);
  }

  getEvmClient(): EVMPredictionClient {
    return this.evm;
  }
}

export type {
  ContractAddresses,
  WalletContext,
  TransactionResult,
  CreateMarketParams,
  MarketState,
};
