// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./DealerNFT.sol";
import "./OracleResolver.sol";

/**
 * @title PredictionMarket
 * @notice Prediction market where predictors specify percentage-based odds (0-100)
 * @dev UUPS upgradeable with dealer NFT-based permissioning
 *
 * Core Mechanism:
 * - Predictors specify a percentage (0-100) representing their desired odds
 * - System finds equilibrium point where total_below/total_above = percentage/(100-percentage)
 * - Predictions at exact equilibrium are auto-refunded
 * - Winners are those who predicted on the correct side of equilibrium
 *
 * Example:
 * - Predictor A bets 1 ETH at 30% (believes 30% chance)
 * - Predictor B bets 2 ETH at 70% (believes 70% chance)
 * - Equilibrium might be at 50% where total below = total above
 * - If actual result is 60%, then B wins (70% > 60% equilibrium)
 */
contract PredictionMarket is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;
    /// @notice Minimum market duration (24 hours)
    uint256 public constant MIN_DURATION = 24 hours;

    /// @notice Grace period for updating predictions (5 minutes)
    uint256 public constant GRACE_PERIOD = 5 minutes;

    /// @notice Additional time after deadline before a market can be abandoned
    uint256 public constant RESOLUTION_GRACE_PERIOD = 24 hours;

    /// @notice Dealer fee bounds (in basis points: 1 bp = 0.01%)
    uint256 public constant MIN_DEALER_FEE_BPS = 10; // 0.1%
    uint256 public constant MAX_DEALER_FEE_BPS = 200; // 2%

    /// @notice System fee as percentage of dealer fee
    uint256 public constant SYSTEM_FEE_PERCENT = 10; // 10% of dealer fee

    /// @notice Market status enum
    enum MarketStatus {
        Active,
        Cancelled,
        Resolved,
        Abandoned
    }

    /// @notice Market struct
    struct Market {
        address dealer; // Dealer who created the market
        uint256 tokenId; // Dealer NFT token ID
        uint256 category; // Market category
        uint256 subCategory; // Market subcategory
        uint256 deadline; // Prediction deadline timestamp
        string description; // Market description
        uint256 createdAt; // Market creation timestamp
        uint256 dealerFeeBps; // Dealer fee in basis points
        MarketStatus status; // Market status
        uint256 resolution; // Resolved percentage (0-100)
        uint256 equilibrium; // Calculated equilibrium point (0-100)
        bytes32 oracleId; // Optional oracle ID for automated resolution
    }

    /// @notice Prediction struct
    struct Prediction {
        uint256 amount; // Total amount bet
        uint256 percentage; // Predicted percentage (0-100)
        uint256 placedAt; // Timestamp when prediction was placed
        bool claimed; // Whether winnings have been claimed
    }

    /// @notice DealerNFT contract reference
    DealerNFT public dealerNFT;

    /// @notice OracleResolver contract reference
    OracleResolver public oracleResolver;

    /// @notice ERC20 stake token (e.g., USDC)
    IERC20 public stakeToken;

    /// @notice Market counter
    uint256 public marketCounter;

    /// @notice Markets mapping: marketId => Market
    mapping(uint256 => Market) public markets;

    /// @notice Predictions mapping: marketId => predictor => Prediction
    mapping(uint256 => mapping(address => Prediction)) public predictions;

    /// @notice Total amount per percentage point: marketId => percentage => total amount
    mapping(uint256 => mapping(uint256 => uint256)) public percentageTotals;

    /// @notice Total pool for each market: marketId => total amount
    mapping(uint256 => uint256) public marketPools;

    /// @notice Collected dealer fees: marketId => fee amount
    mapping(uint256 => uint256) public dealerFees;

    /// @notice Collected system fees: marketId => fee amount
    mapping(uint256 => uint256) public systemFees;

    /// @notice Total accumulated system fees (withdrawable by owner)
    uint256 public totalSystemFees;

    /// @notice Events
    event MarketCreated(
        uint256 indexed marketId,
        address indexed dealer,
        uint256 tokenId,
        uint256 category,
        uint256 subCategory,
        uint256 deadline,
        string description
    );

    event PredictionPlaced(
        uint256 indexed marketId,
        address indexed predictor,
        uint256 amount,
        uint256 percentage
    );

    event PredictionUpdated(
        uint256 indexed marketId,
        address indexed predictor,
        uint256 newAmount,
        uint256 newPercentage
    );

    event MarketResolved(
        uint256 indexed marketId,
        uint256 resolution,
        uint256 equilibrium
    );

    event MarketCancelled(uint256 indexed marketId);
    event MarketAbandoned(uint256 indexed marketId);

    event DealerFeeSet(uint256 indexed marketId, uint256 feeBps);

    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed predictor,
        uint256 amount
    );

    event RefundClaimed(
        uint256 indexed marketId,
        address indexed predictor,
        uint256 amount
    );

    event DealerFeesWithdrawn(
        uint256 indexed marketId,
        address indexed dealer,
        uint256 amount
    );

    event SystemFeesWithdrawn(address indexed recipient, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract
     * @param _dealerNFT Address of the DealerNFT contract
     * @param _oracleResolver Address of the OracleResolver contract
     * @param _stakeToken Address of the ERC20 stake token (USDC)
     */
    function initialize(address _dealerNFT, address _oracleResolver, address _stakeToken) public initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        require(_dealerNFT != address(0), "Dealer NFT required");
        require(_oracleResolver != address(0), "Oracle required");
        require(_stakeToken != address(0), "Stake token required");

        dealerNFT = DealerNFT(_dealerNFT);
        oracleResolver = OracleResolver(_oracleResolver);
        stakeToken = IERC20(_stakeToken);
        marketCounter = 0;
    }

    /**
     * @notice Create a new prediction market
     * @param tokenId Dealer NFT token ID
     * @param category Market category
     * @param subCategory Market subcategory
     * @param deadline Prediction deadline timestamp
     * @param description Market description
     * @param oracleId Optional oracle ID for automated resolution (bytes32(0) for manual)
     */
    function createMarket(
        uint256 tokenId,
        uint256 category,
        uint256 subCategory,
        uint256 deadline,
        string calldata description,
        bytes32 oracleId
    ) external whenNotPaused returns (uint256) {
        // Validate caller owns the dealer NFT
        require(
            dealerNFT.ownerOf(tokenId) == msg.sender,
            "Not token owner"
        );

        // Validate dealer has permission for this category/subcategory
        require(
            dealerNFT.validatePermission(tokenId, category, subCategory),
            "No permission"
        );

        // Validate deadline is at least 24 hours in the future
        require(
            deadline >= block.timestamp + MIN_DURATION,
            "Deadline too soon"
        );

        // Increment counter and create market
        marketCounter++;
        uint256 marketId = marketCounter;

        markets[marketId] = Market({
            dealer: msg.sender,
            tokenId: tokenId,
            category: category,
            subCategory: subCategory,
            deadline: deadline,
            description: description,
            createdAt: block.timestamp,
            dealerFeeBps: MIN_DEALER_FEE_BPS, // Default to minimum fee
            status: MarketStatus.Active,
            resolution: 0,
            equilibrium: 0,
            oracleId: oracleId
        });

        emit MarketCreated(
            marketId,
            msg.sender,
            tokenId,
            category,
            subCategory,
            deadline,
            description
        );

        return marketId;
    }

    /**
     * @notice Set dealer fee for a market
     * @param marketId Market ID
     * @param feeBps Fee in basis points (10-200, i.e., 0.1%-2%)
     */
    function setDealerFee(uint256 marketId, uint256 feeBps) external {
        Market storage market = markets[marketId];
        require(dealerNFT.ownerOf(market.tokenId) == msg.sender, "Not dealer owner");
        require(market.status == MarketStatus.Active, "Market not active");
        require(
            feeBps >= MIN_DEALER_FEE_BPS && feeBps <= MAX_DEALER_FEE_BPS,
            "Fee out of bounds"
        );

        market.dealerFeeBps = feeBps;
        emit DealerFeeSet(marketId, feeBps);
    }

    /**
     * @notice Place a prediction on a market
     * @param marketId Market ID
     * @param percentage Predicted percentage (0-100)
     */
    function placePrediction(uint256 marketId, uint256 percentage, uint256 amount)
        external
        whenNotPaused
        nonReentrant
    {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(block.timestamp < market.deadline, "Market closed");
        require(percentage <= 100, "Invalid percentage");
        require(amount > 0, "Amount zero");

        Prediction storage prediction = predictions[marketId][msg.sender];
        require(prediction.amount == 0, "Already predicted");

        // Transfer stake tokens from predictor
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        // Store prediction
        prediction.amount = amount;
        prediction.percentage = percentage;
        prediction.placedAt = block.timestamp;
        prediction.claimed = false;

        // Update percentage totals and market pool
        percentageTotals[marketId][percentage] += amount;
        marketPools[marketId] += amount;

        emit PredictionPlaced(marketId, msg.sender, amount, percentage);
    }

    /**
     * @notice Update a prediction within grace period
     * @param marketId Market ID
     * @param newPercentage New predicted percentage (0-100)
     * @param additionalAmount Additional amount to add (msg.value)
     */
    function updatePrediction(
        uint256 marketId,
        uint256 newPercentage,
        uint256 additionalAmount
    ) external whenNotPaused nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(block.timestamp < market.deadline, "Market closed");

        Prediction storage prediction = predictions[marketId][msg.sender];
        require(prediction.amount > 0, "No prediction");
        require(
            block.timestamp <= prediction.placedAt + GRACE_PERIOD,
            "Grace period expired"
        );
        require(newPercentage <= 100, "Invalid percentage");

        uint256 previousAmount = prediction.amount;

        // Remove old percentage total
        percentageTotals[marketId][prediction.percentage] -= previousAmount;

        if (additionalAmount > 0) {
            stakeToken.safeTransferFrom(msg.sender, address(this), additionalAmount);
            prediction.amount += additionalAmount;
            marketPools[marketId] += additionalAmount;
        }

        prediction.percentage = newPercentage;

        // Add new percentage total
        percentageTotals[marketId][newPercentage] += prediction.amount;

        emit PredictionUpdated(marketId, msg.sender, prediction.amount, newPercentage);
    }

    /**
     * @notice Withdraw an existing prediction before the market deadline
     * @param marketId Market ID
     */
    function withdrawPrediction(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(block.timestamp < market.deadline, "Market closed");

        Prediction storage prediction = predictions[marketId][msg.sender];
        uint256 amount = prediction.amount;
        require(amount > 0, "No prediction");

        // Update accounting
        percentageTotals[marketId][prediction.percentage] -= amount;
        marketPools[marketId] -= amount;

        delete predictions[marketId][msg.sender];

        stakeToken.safeTransfer(msg.sender, amount);
    }
    /**
     * @notice Resolve a market with the final result
     * @param marketId Market ID
     * @param resolution Final percentage result (0-100)
     */
    function resolveMarket(uint256 marketId, uint256 resolution) external {
        Market storage market = markets[marketId];
        require(dealerNFT.ownerOf(market.tokenId) == msg.sender, "Not dealer owner");
        require(market.status == MarketStatus.Active, "Market not active");
        require(block.timestamp >= market.deadline, "Market still active");
        require(market.oracleId == bytes32(0), "Oracle controlled market");
        require(resolution <= 100, "Invalid resolution");

        _finalizeResolution(marketId, resolution);
    }

    /**
     * @notice Resolve a market using oracle data
     * @param marketId Market ID
     * @dev Anyone can call this after deadline if market has oracle configured
     */
    function resolveMarketWithOracle(uint256 marketId) external {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(block.timestamp >= market.deadline, "Market still active");
        require(market.oracleId != bytes32(0), "No oracle configured");

        // Get oracle data
        (uint256 percentage, uint256 timestamp, bool isValid) =
            oracleResolver.getOracleData(market.oracleId);

        require(isValid, "Oracle data stale");
        require(percentage <= 100, "Invalid oracle percentage");
        require(timestamp != 0 && timestamp >= market.deadline, "Oracle data too early");

        _finalizeResolution(marketId, percentage);

        // Mark oracle data as used (even if market became cancelled)
        oracleResolver.markResolved(market.oracleId);
    }

    /**
     * @notice Cancel a market before any predictions are placed
     * @param marketId Market ID
     */
    function cancelMarket(uint256 marketId) external {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        address dealerOwner = dealerNFT.ownerOf(market.tokenId);
        require(
            msg.sender == dealerOwner || msg.sender == owner(),
            "Not authorized"
        );
        require(marketPools[marketId] == 0, "Predictions exist");

        market.status = MarketStatus.Cancelled;
        emit MarketCancelled(marketId);
    }

    /**
     * @notice Mark market as abandoned when dealer/oracle fails to resolve
     * @param marketId Market ID
     */
    function abandonMarket(uint256 marketId) external {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(
            block.timestamp >= market.deadline + RESOLUTION_GRACE_PERIOD,
            "Resolution grace period active"
        );

        market.status = MarketStatus.Abandoned;
        emit MarketAbandoned(marketId);
    }

    /**
     * @notice Pause the contract (owner only)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract (owner only)
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Calculate equilibrium point for a market
     * @param marketId Market ID
     * @return Equilibrium percentage (0-100)
     * @dev O(101) algorithm: finds point where total_below/total_above = percentage/(100-percentage)
     */
    function calculateEquilibrium(uint256 marketId) public view returns (uint256) {
        // Build cumulative totals for each percentage point
        uint256[101] memory cumulativeBelow;
        uint256[101] memory cumulativeAbove;

        // First, get total for each percentage
        uint256[101] memory percentageTotalsArray;
        for (uint256 i = 0; i <= 100; i++) {
            percentageTotalsArray[i] = percentageTotals[marketId][i];
        }

        // Calculate cumulative below (sum of all percentages < current)
        for (uint256 i = 0; i <= 100; i++) {
            if (i == 0) {
                cumulativeBelow[i] = 0;
            } else {
                cumulativeBelow[i] = cumulativeBelow[i - 1] + percentageTotalsArray[i - 1];
            }
        }

        // Calculate cumulative above (sum of all percentages > current)
        for (uint256 i = 0; i <= 100; i++) {
            uint256 totalAbove = 0;
            for (uint256 j = i + 1; j <= 100; j++) {
                totalAbove += percentageTotalsArray[j];
            }
            cumulativeAbove[i] = totalAbove;
        }

        // Find equilibrium: where ratio matches percentage odds
        // We want: total_below / total_above ≈ percentage / (100 - percentage)
        // Or: total_below * (100 - percentage) ≈ total_above * percentage

        uint256 bestEquilibrium = 0;
        uint256 bestDifference = type(uint256).max;

        for (uint256 p = 1; p < 100; p++) {
            uint256 below = cumulativeBelow[p];
            uint256 above = cumulativeAbove[p];

            // Skip if both sides are zero (no predictions)
            if (below == 0 && above == 0) {
                continue;
            }

            // Calculate difference using a ratio-based approach
            // We want: below / above ≈ p / (100 - p)
            // Cross multiply: below * (100 - p) ≈ above * p

            uint256 leftSide = below * (100 - p);
            uint256 rightSide = above * p;
            uint256 difference;

            if (leftSide > rightSide) {
                difference = leftSide - rightSide;
            } else {
                difference = rightSide - leftSide;
            }

            // Update best equilibrium if this is closer to balance
            if (difference < bestDifference) {
                bestDifference = difference;
                bestEquilibrium = p;
            }
        }

        return bestEquilibrium;
    }

    /**
     * @notice Determine if both sides of the market have liquidity
     * @param marketId Market ID
     * @param equilibrium Equilibrium percentage
     * @return True if there are stakes on both sides of equilibrium
     */
    function _hasTwoSidedMarket(uint256 marketId, uint256 equilibrium) internal view returns (bool) {
        bool hasBelow = false;
        bool hasAbove = false;

        if (equilibrium > 0) {
            for (uint256 i = 0; i < equilibrium; i++) {
                if (percentageTotals[marketId][i] > 0) {
                    hasBelow = true;
                    break;
                }
            }
        }

        if (equilibrium < 100) {
            for (uint256 j = equilibrium + 1; j <= 100; j++) {
                if (percentageTotals[marketId][j] > 0) {
                    hasAbove = true;
                    break;
                }
            }
        }

        return hasBelow && hasAbove;
    }

    /**
     * @notice Internal helper to finalize market resolution or trigger refunds
     * @param marketId Market ID
     * @param resolution Final percentage result
     */
    function _finalizeResolution(uint256 marketId, uint256 resolution) internal {
        Market storage market = markets[marketId];

        uint256 equilibrium = calculateEquilibrium(marketId);
        market.equilibrium = equilibrium;

        if (!_hasTwoSidedMarket(marketId, equilibrium)) {
            market.status = MarketStatus.Cancelled;
            emit MarketCancelled(marketId);
            return;
        }

        market.status = MarketStatus.Resolved;
        market.resolution = resolution;

        emit MarketResolved(marketId, resolution, equilibrium);
    }

    /**
     * @notice Check if a predictor is a winner
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return True if predictor won
     * @dev Winner = predicted on same side of equilibrium as actual result
     */
    function isWinner(uint256 marketId, address predictor) public view returns (bool) {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.Resolved ||
                market.status == MarketStatus.Cancelled ||
                market.status == MarketStatus.Abandoned,
            "Market not finalized"
        );

        Prediction storage prediction = predictions[marketId][predictor];
        require(prediction.amount > 0, "No prediction");

        uint256 equilibrium = market.equilibrium;
        uint256 resolution = market.resolution;
        uint256 predicted = prediction.percentage;

        // Auto-refund if predicted exactly at equilibrium
        if (predicted == equilibrium) {
            return false;
        }

        // Winner if on same side as resolution
        if (resolution > equilibrium) {
            // Result is above equilibrium, winners predicted above equilibrium
            return predicted > equilibrium;
        } else if (resolution < equilibrium) {
            // Result is below equilibrium, winners predicted below equilibrium
            return predicted < equilibrium;
        } else {
            // Resolution exactly at equilibrium - no winners
            return false;
        }
    }

    /**
     * @notice Get refund amount for a predictor (equilibrium/cancelled/abandoned)
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return Refund amount
     */
    function getRefundAmount(uint256 marketId, address predictor) public view returns (uint256) {
        Market storage market = markets[marketId];
        Prediction storage prediction = predictions[marketId][predictor];
        if (prediction.amount == 0) {
            return 0;
        }

        if (
            market.status == MarketStatus.Cancelled ||
            market.status == MarketStatus.Abandoned
        ) {
            return prediction.amount;
        }

        if (market.status != MarketStatus.Resolved) {
            return 0;
        }

        // Refund if predicted exactly at equilibrium
        if (prediction.percentage == market.equilibrium) {
            return prediction.amount;
        }

        return 0;
    }

    /**
     * @notice Calculate total winning bets for a market
     * @param marketId Market ID
     * @return Total amount on winning side
     */
    function _calculateTotalWinningBets(uint256 marketId)
        internal
        view
        returns (uint256)
    {
        Market storage market = markets[marketId];
        uint256 totalWinningBets = 0;
        uint256 equilibrium = market.equilibrium;
        uint256 resolution = market.resolution;

        for (uint256 i = 0; i <= 100; i++) {
            uint256 amount = percentageTotals[marketId][i];
            if (amount > 0 && i != equilibrium) {
                if (
                    (resolution > equilibrium && i > equilibrium) ||
                    (resolution < equilibrium && i < equilibrium)
                ) {
                    totalWinningBets += amount;
                }
            }
        }

        return totalWinningBets;
    }

    /**
     * @notice Calculate payout for a winner
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return Payout amount
     * @dev Calculates proportional share of winner pool after fees
     */
    function calculatePayout(uint256 marketId, address predictor)
        public
        view
        returns (uint256)
    {
        Market storage market = markets[marketId];
        if (market.status != MarketStatus.Resolved) {
            return 0;
        }

        Prediction storage prediction = predictions[marketId][predictor];
        if (prediction.amount == 0 || prediction.claimed) {
            return 0;
        }

        // Check if winner
        if (!isWinner(marketId, predictor)) {
            return 0;
        }

        // Calculate fees
        uint256 totalPool = marketPools[marketId];
        uint256 equilibriumAmount = percentageTotals[marketId][market.equilibrium];
        uint256 distributablePool = totalPool > equilibriumAmount ? totalPool - equilibriumAmount : 0;
        uint256 dealerFee = (distributablePool * market.dealerFeeBps) / 10000;
        uint256 systemFee = (dealerFee * SYSTEM_FEE_PERCENT) / 100;

        // Winner pool = total pool - refundable stakes - fees
        uint256 winnerPool = distributablePool - dealerFee - systemFee;

        // Get total winning bets
        uint256 totalWinningBets = _calculateTotalWinningBets(marketId);

        if (totalWinningBets == 0) {
            return 0;
        }

        // Payout = (predictor_bet / total_winning_bets) * winner_pool
        return (prediction.amount * winnerPool) / totalWinningBets;
    }

    /**
     * @notice Claim winnings for a resolved market
     * @param marketId Market ID
     */
    function claimWinnings(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.Resolved ||
                market.status == MarketStatus.Cancelled ||
                market.status == MarketStatus.Abandoned,
            "Market not finalized"
        );

        Prediction storage prediction = predictions[marketId][msg.sender];
        require(prediction.amount > 0, "No prediction");
        require(!prediction.claimed, "Already claimed");
        require(isWinner(marketId, msg.sender), "Not a winner");

        uint256 payout = calculatePayout(marketId, msg.sender);
        require(payout > 0, "No payout");

        // Mark as claimed
        prediction.claimed = true;

        // Transfer payout
        stakeToken.safeTransfer(msg.sender, payout);

        emit WinningsClaimed(marketId, msg.sender, payout);
    }

    /**
     * @notice Claim refund for eligible predictions (equilibrium or cancellation flows)
     * @param marketId Market ID
     */
    function claimRefund(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.Resolved ||
                market.status == MarketStatus.Cancelled ||
                market.status == MarketStatus.Abandoned,
            "Market not finalized"
        );

        Prediction storage prediction = predictions[marketId][msg.sender];
        require(prediction.amount > 0, "No prediction");
        require(!prediction.claimed, "Already claimed");

        uint256 refundAmount = getRefundAmount(marketId, msg.sender);
        require(refundAmount > 0, "No refund");

        // Mark as claimed
        prediction.claimed = true;

        // Transfer refund
        stakeToken.safeTransfer(msg.sender, refundAmount);

        emit RefundClaimed(marketId, msg.sender, refundAmount);
    }

    /**
     * @notice Withdraw dealer fees for a resolved market
     * @param marketId Market ID
     */
    function withdrawDealerFees(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Resolved, "Market not resolved");
        require(dealerNFT.ownerOf(market.tokenId) == msg.sender, "Not dealer owner");

        uint256 feeAmount = dealerFees[marketId];
        if (feeAmount == 0) {
            // Calculate and store dealer fee
            uint256 totalPool = marketPools[marketId];
            uint256 dealerFeeBps = market.dealerFeeBps;
            uint256 equilibriumAmount = percentageTotals[marketId][market.equilibrium];
            uint256 distributablePool = totalPool > equilibriumAmount ? totalPool - equilibriumAmount : 0;
            feeAmount = (distributablePool * dealerFeeBps) / 10000;

            dealerFees[marketId] = feeAmount;

            // Also calculate and store system fee
            uint256 systemFee = (feeAmount * SYSTEM_FEE_PERCENT) / 100;
            systemFees[marketId] = systemFee;
            totalSystemFees += systemFee;
        }

        require(feeAmount > 0, "No fees");

        // Mark as withdrawn
        dealerFees[marketId] = 0;

        // Transfer fees
        stakeToken.safeTransfer(msg.sender, feeAmount);

        emit DealerFeesWithdrawn(marketId, msg.sender, feeAmount);
    }

    /**
     * @notice Withdraw accumulated system fees (owner only)
     */
    function withdrawSystemFees() external onlyOwner nonReentrant {
        uint256 amount = totalSystemFees;
        require(amount > 0, "No fees");

        totalSystemFees = 0;

        stakeToken.safeTransfer(msg.sender, amount);

        emit SystemFeesWithdrawn(msg.sender, amount);
    }

    /**
     * @notice Authorize upgrade (only owner can upgrade)
     * @dev Required by UUPSUpgradeable
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /**
     * @dev Storage gap for future upgrades
     */
    uint256[50] private __gap;
}
