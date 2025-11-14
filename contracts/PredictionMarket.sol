// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
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
    /// @notice Minimum market duration (24 hours)
    uint256 public constant MIN_DURATION = 24 hours;

    /// @notice Grace period for updating predictions (5 minutes)
    uint256 public constant GRACE_PERIOD = 5 minutes;

    /// @notice Minimum bet amount (0.001 ETH)
    uint256 public constant MIN_BET = 0.001 ether;

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

    /// @notice Market counter
    uint256 public marketCounter;

    /// @notice Markets mapping: marketId => Market
    mapping(uint256 => Market) public markets;

    /// @notice Predictions mapping: marketId => predictor => Prediction
    mapping(uint256 => mapping(address => Prediction)) public predictions;

    /// @notice Total amount per percentage point: marketId => percentage => total amount
    mapping(uint256 => mapping(uint256 => uint256)) public percentageTotals;

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

    event MarketAbandoned(uint256 indexed marketId);

    event DealerFeeSet(uint256 indexed marketId, uint256 feeBps);

    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed predictor,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract
     * @param _dealerNFT Address of the DealerNFT contract
     * @param _oracleResolver Address of the OracleResolver contract
     */
    function initialize(address _dealerNFT, address _oracleResolver) public initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        dealerNFT = DealerNFT(_dealerNFT);
        oracleResolver = OracleResolver(_oracleResolver);
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
        require(market.dealer == msg.sender, "Not market dealer");
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
    function placePrediction(uint256 marketId, uint256 percentage)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(block.timestamp < market.deadline, "Market closed");
        require(percentage <= 100, "Invalid percentage");
        require(msg.value >= MIN_BET, "Below minimum");

        Prediction storage prediction = predictions[marketId][msg.sender];
        require(prediction.amount == 0, "Already predicted");

        // Store prediction
        prediction.amount = msg.value;
        prediction.percentage = percentage;
        prediction.placedAt = block.timestamp;
        prediction.claimed = false;

        // Update percentage totals
        percentageTotals[marketId][percentage] += msg.value;

        emit PredictionPlaced(marketId, msg.sender, msg.value, percentage);
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
    ) external payable whenNotPaused nonReentrant {
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
        require(msg.value == additionalAmount, "Amount mismatch");

        // Remove old percentage total
        percentageTotals[marketId][prediction.percentage] -= prediction.amount;

        // Update prediction
        prediction.amount += additionalAmount;
        prediction.percentage = newPercentage;

        // Add new percentage total
        percentageTotals[marketId][newPercentage] += prediction.amount;

        emit PredictionUpdated(marketId, msg.sender, prediction.amount, newPercentage);
    }

    /**
     * @notice Resolve a market with the final result
     * @param marketId Market ID
     * @param resolution Final percentage result (0-100)
     */
    function resolveMarket(uint256 marketId, uint256 resolution) external {
        Market storage market = markets[marketId];
        require(market.dealer == msg.sender, "Not market dealer");
        require(market.status == MarketStatus.Active, "Market not active");
        require(block.timestamp >= market.deadline, "Market still active");
        require(resolution <= 100, "Invalid resolution");

        // Calculate equilibrium
        uint256 equilibrium = calculateEquilibrium(marketId);

        market.status = MarketStatus.Resolved;
        market.resolution = resolution;
        market.equilibrium = equilibrium;

        emit MarketResolved(marketId, resolution, equilibrium);
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

        // Calculate equilibrium
        uint256 equilibrium = calculateEquilibrium(marketId);

        market.status = MarketStatus.Resolved;
        market.resolution = percentage;
        market.equilibrium = equilibrium;

        // Mark oracle data as used
        oracleResolver.markResolved(market.oracleId);

        emit MarketResolved(marketId, percentage, equilibrium);
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
     * @notice Check if a predictor is a winner
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return True if predictor won
     * @dev Winner = predicted on same side of equilibrium as actual result
     */
    function isWinner(uint256 marketId, address predictor) public view returns (bool) {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Resolved, "Market not resolved");

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
     * @notice Get refund amount for a predictor (if at equilibrium)
     * @param marketId Market ID
     * @param predictor Predictor address
     * @return Refund amount
     */
    function getRefundAmount(uint256 marketId, address predictor) public view returns (uint256) {
        Market storage market = markets[marketId];
        if (market.status != MarketStatus.Resolved) {
            return 0;
        }

        Prediction storage prediction = predictions[marketId][predictor];
        if (prediction.amount == 0) {
            return 0;
        }

        // Refund if predicted exactly at equilibrium
        if (prediction.percentage == market.equilibrium) {
            return prediction.amount;
        }

        return 0;
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
