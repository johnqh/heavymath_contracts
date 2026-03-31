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
 * - After the deadline, anyone can lock the market which calculates the equilibrium
 * - Locking splits bettors into two sides: positive (above equilibrium) and
 *   negative (below equilibrium), partially refunding the overweight side pro-rata
 * - Resolution is binary: the dealer or oracle decides which side (positive/negative) wins
 *
 * Market Lifecycle:
 * Active -> Locked -> Resolved (or Cancelled/Abandoned at various stages)
 *
 * Fee Structure:
 * - A single fee (winnerFeeBps, default 1%) is charged on the winning side's distributable pool
 * - The fee is split between the dealer and the platform (dealerSharePercent, default 50%)
 * - Both parameters are contract-level and can only be modified by the contract owner
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

    /// @notice Additional time after deadline before a market can be abandoned
    uint256 public constant RESOLUTION_GRACE_PERIOD = 24 hours;

    /// @notice Fee charged on the winning side (in basis points: 1 bp = 0.01%), modifiable by owner
    uint256 public winnerFeeBps; // default 100 = 1%

    /// @notice Dealer's share of the fee (as percentage 0-100), modifiable by owner
    uint256 public dealerSharePercent; // default 50 = 50%

    /// @notice Market status enum
    enum MarketStatus {
        Active,
        Cancelled,
        Resolved,
        Abandoned,
        Locked
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
        uint256 dealerFeeBps; // DEPRECATED: always 0. Kept for storage layout compatibility with deployed proxies. Fee model now uses contract-level winnerFeeBps + dealerSharePercent.
        MarketStatus status; // Market status
        bool positiveOutcome; // Whether the positive (above equilibrium) side won
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

    /// @notice Lock refund info for partial refunds after locking
    struct LockRefundInfo {
        bool overweightIsBelow; // true = below side was overweight
        uint256 excessAmount; // total excess to refund from overweight side
        uint256 overweightTotal; // total amount on overweight side before refund
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

    event MarketLocked(uint256 indexed marketId, uint256 equilibrium);

    event MarketResolved(
        uint256 indexed marketId,
        bool positiveOutcome,
        uint256 equilibrium
    );

    event MarketCancelled(uint256 indexed marketId);
    event MarketAbandoned(uint256 indexed marketId);

    event WinnerFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event DealerSharePercentUpdated(uint256 oldPercent, uint256 newPercent);

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

    event LockRefundClaimed(
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

        winnerFeeBps = 100; // 1%
        dealerSharePercent = 50; // 50/50 split
        testMode = true;
    }

    /**
     * @notice Enable or disable test mode (owner only)
     * @param _testMode true to allow locking/resolving without waiting for deadline
     */
    function setTestMode(bool _testMode) external onlyOwner {
        testMode = _testMode;
    }

    /**
     * @notice Set the winner fee in basis points (owner only)
     * @param _winnerFeeBps Fee in basis points (e.g. 100 = 1%)
     */
    function setWinnerFeeBps(uint256 _winnerFeeBps) external onlyOwner {
        require(_winnerFeeBps <= 1000, "Fee too high"); // max 10%
        uint256 old = winnerFeeBps;
        winnerFeeBps = _winnerFeeBps;
        emit WinnerFeeBpsUpdated(old, _winnerFeeBps);
    }

    /**
     * @notice Set the dealer's share of the fee as a percentage (owner only)
     * @param _dealerSharePercent Percentage 0-100 (e.g. 50 = 50%)
     */
    function setDealerSharePercent(uint256 _dealerSharePercent) external onlyOwner {
        require(_dealerSharePercent <= 100, "Invalid percent");
        uint256 old = dealerSharePercent;
        dealerSharePercent = _dealerSharePercent;
        emit DealerSharePercentUpdated(old, _dealerSharePercent);
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
            dealerFeeBps: 0, // DEPRECATED: see struct definition
            status: MarketStatus.Active,
            positiveOutcome: false,
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
     * @notice Update a prediction before the market deadline
     * @param marketId Market ID
     * @param newPercentage New predicted percentage (0-100)
     * @param additionalAmount Additional amount to add
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

    // ========== LOCK MARKET ==========

    /**
     * @notice Lock a market after the deadline. Calculates equilibrium, partially
     * refunds the overweight side pro-rata, and converts to binary (above/below).
     * @param marketId Market ID
     * @dev Anyone can call this after the deadline.
     */
    function lockMarket(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(testMode || block.timestamp >= market.deadline, "Market still active");

        uint256 equilibrium = calculateEquilibrium(marketId);

        _lockWithEquilibrium(marketId, equilibrium);
    }

    /**
     * @notice Lock a market with a pre-computed equilibrium (gas-optimized)
     * @param marketId Market ID
     * @param equilibrium Pre-computed equilibrium percentage (1-99)
     */
    function lockMarketWithEquilibrium(uint256 marketId, uint256 equilibrium) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(testMode || block.timestamp >= market.deadline, "Market still active");
        require(equilibrium > 0 && equilibrium < 100, "Invalid equilibrium");

        _lockWithEquilibrium(marketId, equilibrium);
    }

    /**
     * @notice Claim partial refund from market locking (overweight side pro-rata)
     * @param marketId Market ID
     */
    function claimLockRefund(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.Locked ||
            market.status == MarketStatus.Resolved,
            "Market not locked or resolved"
        );
        require(!lockRefundClaimed[marketId][msg.sender], "Already claimed");

        uint256 refund = getLockRefundAmount(marketId, msg.sender);
        require(refund > 0, "No lock refund");

        lockRefundClaimed[marketId][msg.sender] = true;
        stakeToken.safeTransfer(msg.sender, refund);

        emit LockRefundClaimed(marketId, msg.sender, refund);
    }

    /**
     * @notice Get the partial lock refund amount for a predictor
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return Partial refund amount (0 if not eligible)
     */
    function getLockRefundAmount(uint256 marketId, address predictor) public view returns (uint256) {
        Market storage market = markets[marketId];
        if (market.status != MarketStatus.Locked && market.status != MarketStatus.Resolved) {
            return 0;
        }
        if (lockRefundClaimed[marketId][predictor]) {
            return 0;
        }

        Prediction storage prediction = predictions[marketId][predictor];
        if (prediction.amount == 0) {
            return 0;
        }
        // Equilibrium bettors get full refund via claimRefund, not lock refund
        if (prediction.percentage == market.equilibrium) {
            return 0;
        }

        LockRefundInfo storage lockInfo = lockRefunds[marketId];
        if (lockInfo.excessAmount == 0) {
            return 0;
        }

        bool predictorIsBelow = prediction.percentage < market.equilibrium;
        if (predictorIsBelow == lockInfo.overweightIsBelow) {
            return (prediction.amount * lockInfo.excessAmount) / lockInfo.overweightTotal;
        }
        return 0;
    }

    // ========== RESOLUTION ==========

    /**
     * @notice Resolve a locked market with a binary outcome (dealer only, non-oracle)
     * @param marketId Market ID
     * @param positiveOutcome true = positive (above equilibrium) side wins, false = negative (below) wins
     */
    function resolveMarket(uint256 marketId, bool positiveOutcome) external {
        Market storage market = markets[marketId];
        require(dealerNFT.ownerOf(market.tokenId) == msg.sender, "Not dealer owner");
        require(market.status == MarketStatus.Locked, "Market not locked");
        require(market.oracleId == bytes32(0), "Oracle controlled market");

        market.status = MarketStatus.Resolved;
        market.positiveOutcome = positiveOutcome;

        emit MarketResolved(marketId, positiveOutcome, market.equilibrium);
    }

    /**
     * @notice Resolve a locked market using oracle data (anyone can call)
     * @param marketId Market ID
     * @dev Oracle returns a percentage (0-100). If it is above the equilibrium,
     *      the positive side wins; otherwise the negative side wins.
     */
    function resolveMarketWithOracle(uint256 marketId) external {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Locked, "Market not locked");
        require(market.oracleId != bytes32(0), "No oracle configured");

        // Get oracle data
        (uint256 percentage, uint256 timestamp, bool isValid) =
            oracleResolver.getOracleData(market.oracleId);

        require(isValid, "Oracle data stale");
        require(percentage <= 100, "Invalid oracle percentage");
        require(timestamp != 0 && timestamp >= market.deadline, "Oracle data too early");

        // Binary outcome: oracle value above equilibrium → positive side wins
        bool positiveOutcome = percentage > market.equilibrium;

        market.status = MarketStatus.Resolved;
        market.positiveOutcome = positiveOutcome;

        emit MarketResolved(marketId, positiveOutcome, market.equilibrium);

        // Mark oracle data as used
        oracleResolver.markResolved(market.oracleId);
    }

    // ========== CANCEL / ABANDON ==========

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
     * @notice Mark market as abandoned when it isn't resolved in time
     * @param marketId Market ID
     * @dev Can be called on Active or Locked markets after the grace period
     */
    function abandonMarket(uint256 marketId) external {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.Active || market.status == MarketStatus.Locked,
            "Market not active or locked"
        );
        require(
            block.timestamp >= market.deadline + RESOLUTION_GRACE_PERIOD,
            "Resolution grace period active"
        );

        market.status = MarketStatus.Abandoned;
        emit MarketAbandoned(marketId);
    }

    // ========== PAUSE ==========

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

    // ========== EQUILIBRIUM ==========

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
        // O(n) reverse cumulative sum: cumulativeAbove[i] = cumulativeAbove[i+1] + totals[i+1]
        cumulativeAbove[100] = 0;
        for (uint256 i = 100; i > 0; i--) {
            cumulativeAbove[i - 1] = cumulativeAbove[i] + percentageTotalsArray[i];
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

    // ========== CLAIMS ==========

    /**
     * @notice Check if a predictor is a winner
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return True if predictor won
     * @dev Winner = predicted on the side that the binary resolution chose
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

        uint256 predicted = prediction.percentage;
        uint256 equilibrium = market.equilibrium;

        // Equilibrium bettors are always refunded, never winners
        if (predicted == equilibrium) {
            return false;
        }

        // Binary resolution: positive side (above eq) or negative side (below eq)
        if (market.positiveOutcome) {
            return predicted > equilibrium;
        } else {
            return predicted < equilibrium;
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

        // Equilibrium bettors get full refund when market is locked or resolved
        if (
            (market.status == MarketStatus.Locked || market.status == MarketStatus.Resolved) &&
            prediction.percentage == market.equilibrium
        ) {
            return prediction.amount;
        }

        return 0;
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
     * @notice Claim refund for eligible predictions (equilibrium, cancellation, or abandonment)
     * @param marketId Market ID
     */
    function claimRefund(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(
            market.status == MarketStatus.Resolved ||
                market.status == MarketStatus.Cancelled ||
                market.status == MarketStatus.Abandoned ||
                market.status == MarketStatus.Locked,
            "Market not finalized or locked"
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

    // ========== FEES ==========

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
            // Calculate and store fees on first call
            uint256 distributablePool = _getDistributablePool(marketId);
            (, uint256 dealerFee, uint256 systemFee) = _calculateFees(distributablePool);

            feeAmount = dealerFee;
            dealerFees[marketId] = feeAmount;

            // Store system fee
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

    // ========== PAYOUT CALCULATION ==========

    /**
     * @notice Calculate payout for a winner
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return Payout amount
     * @dev Uses effective amounts (after partial lock refunds) for proportional share
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

        // Calculate fees on distributable pool (after lock refunds + equilibrium removal)
        uint256 distributablePool = _getDistributablePool(marketId);
        (uint256 totalFee,,) = _calculateFees(distributablePool);

        // Winner pool = distributable pool - total fees
        uint256 winnerPool = distributablePool - totalFee;

        // Get total winning bets (effective amounts)
        uint256 totalWinningBets = _calculateTotalWinningBets(marketId);

        if (totalWinningBets == 0) {
            return 0;
        }

        // Use effective amount for this predictor
        uint256 effectiveAmount = _getEffectiveAmount(marketId, prediction.amount, prediction.percentage);

        // Payout = (effective_bet / total_winning_bets) * winner_pool
        return (effectiveAmount * winnerPool) / totalWinningBets;
    }

    // ========== INTERNAL HELPERS ==========

    /**
     * @notice Internal lock implementation
     * @param marketId Market ID
     * @param equilibrium Equilibrium percentage
     */
    function _lockWithEquilibrium(uint256 marketId, uint256 equilibrium) internal {
        Market storage market = markets[marketId];

        require(equilibrium > 0 && equilibrium < 100, "No valid equilibrium");
        require(_hasTwoSidedMarket(marketId, equilibrium), "One-sided market");

        // Calculate below and above totals
        uint256 below = _calculateSideTotal(marketId, equilibrium, true);
        uint256 above = _calculateSideTotal(marketId, equilibrium, false);

        uint256 leftSide = below * (100 - equilibrium);
        uint256 rightSide = above * equilibrium;

        LockRefundInfo storage lockInfo = lockRefunds[marketId];

        if (leftSide > rightSide) {
            // Below side is overweight
            uint256 targetBelow = (above * equilibrium) / (100 - equilibrium);
            uint256 excess = below - targetBelow;
            lockInfo.overweightIsBelow = true;
            lockInfo.excessAmount = excess;
            lockInfo.overweightTotal = below;
            marketPools[marketId] -= excess;
        } else if (rightSide > leftSide) {
            // Above side is overweight
            uint256 targetAbove = (below * (100 - equilibrium)) / equilibrium;
            uint256 excess = above - targetAbove;
            lockInfo.overweightIsBelow = false;
            lockInfo.excessAmount = excess;
            lockInfo.overweightTotal = above;
            marketPools[marketId] -= excess;
        }
        // If perfectly balanced, no partial refunds needed

        market.equilibrium = equilibrium;
        market.status = MarketStatus.Locked;

        emit MarketLocked(marketId, equilibrium);
    }

    /**
     * @notice Calculate total amount on one side of equilibrium
     * @param marketId Market ID
     * @param equilibrium Equilibrium percentage
     * @param isBelow true for below side, false for above side
     */
    function _calculateSideTotal(uint256 marketId, uint256 equilibrium, bool isBelow) internal view returns (uint256) {
        uint256 total = 0;
        if (isBelow) {
            for (uint256 i = 0; i < equilibrium; i++) {
                total += percentageTotals[marketId][i];
            }
        } else {
            for (uint256 i = equilibrium + 1; i <= 100; i++) {
                total += percentageTotals[marketId][i];
            }
        }
        return total;
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
     * @notice Get effective amount for a predictor after lock refunds
     * @param marketId Market ID
     * @param amount Original prediction amount
     * @param percentage Predicted percentage
     * @return Effective amount after partial refund
     */
    function _getEffectiveAmount(uint256 marketId, uint256 amount, uint256 percentage) internal view returns (uint256) {
        Market storage market = markets[marketId];
        LockRefundInfo storage lockInfo = lockRefunds[marketId];

        if (lockInfo.excessAmount == 0) {
            return amount;
        }
        if (percentage == market.equilibrium) {
            return 0;
        }

        bool isBelow = percentage < market.equilibrium;
        if (isBelow == lockInfo.overweightIsBelow) {
            uint256 refund = (amount * lockInfo.excessAmount) / lockInfo.overweightTotal;
            return amount - refund;
        }
        return amount;
    }

    /**
     * @notice Calculate total winning bets using effective amounts
     * @param marketId Market ID
     * @return Total effective amount on winning side
     */
    function _calculateTotalWinningBets(uint256 marketId)
        internal
        view
        returns (uint256)
    {
        Market storage market = markets[marketId];
        uint256 totalWinningBets = 0;
        uint256 equilibrium = market.equilibrium;
        bool positive = market.positiveOutcome;

        for (uint256 i = 0; i <= 100; i++) {
            uint256 amount = percentageTotals[marketId][i];
            if (amount > 0 && i != equilibrium) {
                if (
                    (positive && i > equilibrium) ||
                    (!positive && i < equilibrium)
                ) {
                    totalWinningBets += _getEffectiveAmount(marketId, amount, i);
                }
            }
        }

        return totalWinningBets;
    }

    /**
     * @notice Get distributable pool (total pool minus equilibrium stakes minus lock refund excess)
     * @param marketId Market ID
     * @return Distributable pool amount
     */
    function _getDistributablePool(uint256 marketId) internal view returns (uint256) {
        Market storage market = markets[marketId];
        uint256 pool = marketPools[marketId]; // Already has lock refund excess subtracted
        uint256 equilibriumAmount = percentageTotals[marketId][market.equilibrium];
        return pool > equilibriumAmount ? pool - equilibriumAmount : 0;
    }

    /**
     * @notice Calculate fees for a market's distributable pool
     * @param distributablePool The pool after removing equilibrium stakes
     * @return totalFee Total fee amount
     * @return dealerFee Dealer's share of the fee
     * @return systemFee Platform's share of the fee
     */
    function _calculateFees(uint256 distributablePool)
        internal
        view
        returns (uint256 totalFee, uint256 dealerFee, uint256 systemFee)
    {
        totalFee = (distributablePool * winnerFeeBps) / 10000;
        dealerFee = (totalFee * dealerSharePercent) / 100;
        systemFee = totalFee - dealerFee;
    }

    /**
     * @notice Authorize upgrade (only owner can upgrade)
     * @dev Required by UUPSUpgradeable
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ========== NEW STORAGE (consumes gap slots) ==========

    /// @notice Lock refund info per market: marketId => LockRefundInfo
    mapping(uint256 => LockRefundInfo) public lockRefunds;

    /// @notice Whether a predictor has claimed their lock partial refund
    mapping(uint256 => mapping(address => bool)) public lockRefundClaimed;

    /// @notice When true, markets can be locked/resolved without waiting for the deadline
    bool public testMode;

    /**
     * @dev Storage gap for future upgrades (reduced from 48 to 45)
     */
    uint256[45] private __gap;
}
