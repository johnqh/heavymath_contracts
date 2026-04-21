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
        bytes32 conditionData; // Encoded resolution condition (0x0 = legacy WinLoss)
    }

    /// @notice Prediction struct
    struct Prediction {
        uint256 amount; // Total amount bet
        uint256 percentage; // Predicted percentage (0-100)
        uint256 placedAt; // Timestamp when prediction was placed
        bool claimed; // Whether winnings have been claimed
    }

    /// @notice Market split info after locking
    struct LockRefundInfo {
        uint256 negativePercentage;    // boundary pct for negative side (bets <= this are negative)
        uint256 positivePercentage;    // boundary pct for positive side (bets >= this are positive)
        uint256 negativeAllowedAmount; // max allowed amount at negative boundary (partial refund if actual > this)
        uint256 positiveAllowedAmount; // max allowed amount at positive boundary (partial refund if actual > this)
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
        string description,
        bytes32 oracleId,
        bytes32 conditionData
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
        testMode = false;
    }

    /**
     * @notice Enable or disable test mode (owner only)
     * @param _testMode true to allow locking/resolving without waiting for deadline
     */
    function setTestMode(bool _testMode) external onlyOwner {
        testMode = _testMode;
    }

    /**
     * @notice Set the authorized resolver address (owner only)
     * @param _resolver Address authorized to resolve oracle markets directly
     */
    function setAuthorizedResolver(address _resolver) external onlyOwner {
        authorizedResolver = _resolver;
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
        return _createMarket(tokenId, category, subCategory, deadline, description, oracleId, bytes32(0));
    }

    /**
     * @notice Create a new prediction market with condition data
     * @param tokenId Dealer NFT token ID
     * @param category Market category
     * @param subCategory Market subcategory
     * @param deadline Prediction deadline (must be > 24h from now)
     * @param description Market description
     * @param oracleId Optional oracle ID for automated resolution (bytes32(0) for manual)
     * @param conditionData Encoded resolution condition (bytes32(0) for legacy WinLoss)
     */
    function createMarketWithCondition(
        uint256 tokenId,
        uint256 category,
        uint256 subCategory,
        uint256 deadline,
        string calldata description,
        bytes32 oracleId,
        bytes32 conditionData
    ) external whenNotPaused returns (uint256) {
        return _createMarket(tokenId, category, subCategory, deadline, description, oracleId, conditionData);
    }

    /**
     * @dev Internal market creation logic
     */
    function _createMarket(
        uint256 tokenId,
        uint256 category,
        uint256 subCategory,
        uint256 deadline,
        string calldata description,
        bytes32 oracleId,
        bytes32 conditionData
    ) internal returns (uint256) {
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

        // Auto-register oracle if oracleId is provided
        if (oracleId != bytes32(0)) {
            oracleResolver.registerOracleForMarket(oracleId);
        }

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
            oracleId: oracleId,
            conditionData: conditionData
        });

        emit MarketCreated(
            marketId,
            msg.sender,
            tokenId,
            category,
            subCategory,
            deadline,
            description,
            oracleId,
            conditionData
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
     * @notice Lock a market after the deadline. Calculates the market split,
     * partially refunds overweight boundaries and middle percentages.
     * @param marketId Market ID
     * @dev Anyone can call this after the deadline.
     */
    function lockMarket(uint256 marketId) external nonReentrant {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Active, "Market not active");
        require(testMode || block.timestamp >= market.deadline, "Market still active");

        (uint256 negPct, uint256 posPct, uint256 negAmt, uint256 posAmt, bool valid) = calculateMarketSplit(marketId);
        require(valid, "No valid market split");

        _lockWithSplit(marketId, negPct, posPct, negAmt, posAmt);
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

        LockRefundInfo storage lockInfo = lockRefunds[marketId];
        uint256 pct = prediction.percentage;

        // Partial refund at negative boundary
        if (pct == lockInfo.negativePercentage) {
            uint256 actualTotal = percentageTotals[marketId][pct];
            if (actualTotal > lockInfo.negativeAllowedAmount) {
                uint256 excess = actualTotal - lockInfo.negativeAllowedAmount;
                return (prediction.amount * excess) / actualTotal;
            }
        }

        // Partial refund at positive boundary
        if (pct == lockInfo.positivePercentage) {
            uint256 actualTotal = percentageTotals[marketId][pct];
            if (actualTotal > lockInfo.positiveAllowedAmount) {
                uint256 excess = actualTotal - lockInfo.positiveAllowedAmount;
                return (prediction.amount * excess) / actualTotal;
            }
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
     * @notice Resolve a locked oracle market with a binary outcome (authorized resolver only)
     * @param marketId Market ID
     * @param positiveOutcome true = positive (above equilibrium) side wins, false = negative (below) wins
     * @dev The authorized resolver computes the game result off-chain (via sports API)
     *      and submits the outcome directly. No OracleResolver interaction needed.
     */
    function resolveMarketByResolver(uint256 marketId, bool positiveOutcome) external {
        require(msg.sender == authorizedResolver || msg.sender == owner(), "Not authorized resolver");
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Locked, "Market not locked");
        require(market.oracleId != bytes32(0), "Not an oracle market");

        market.status = MarketStatus.Resolved;
        market.positiveOutcome = positiveOutcome;

        emit MarketResolved(marketId, positiveOutcome, market.equilibrium);
    }

    /**
     * @notice Resolve a locked market using oracle data (anyone can call)
     * @param marketId Market ID
     * @dev Oracle returns a percentage (0-100). If it is above the equilibrium,
     *      the positive side wins; otherwise the negative side wins.
     * @dev DEPRECATED: Use resolveMarketByResolver for authorized resolver flow
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

    /**
     * @notice Request oracle resolution via Chainlink Any API (step 1 of 2)
     * @param marketId Market ID
     * @dev Anyone can call. Sends a Chainlink request to the resolve API endpoint.
     *      The API determines if the game has ended and returns the result (0 or 1).
     *      After the Chainlink callback delivers the result, call completeOracleResolution().
     */
    function requestOracleResolution(uint256 marketId) external {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Locked, "Market not locked");
        require(market.oracleId != bytes32(0), "No oracle configured");
        require(
            !oracleResolver.pendingResolution(marketId),
            "Resolution already pending"
        );

        oracleResolver.requestResolution(marketId, market.oracleId);
    }

    /**
     * @notice Complete oracle resolution after Chainlink callback (step 2 of 2)
     * @param marketId Market ID
     * @dev Anyone can call after the Chainlink callback has delivered the result.
     *      Reads the oracle result and resolves the market.
     */
    function completeOracleResolution(uint256 marketId) external {
        Market storage market = markets[marketId];
        require(market.status == MarketStatus.Locked, "Market not locked");
        require(market.oracleId != bytes32(0), "No oracle configured");

        // Read the result that Chainlink delivered to OracleResolver
        (uint256 percentage, uint256 timestamp, bool isValid) =
            oracleResolver.getOracleData(market.oracleId);

        require(isValid, "Oracle data not available");
        require(timestamp != 0, "No oracle data");

        // percentage is 0 or 100 (from Chainlink result 0 or 1)
        // 100 > any equilibrium → positive wins
        // 0 < any equilibrium → negative wins
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

    // ========== MARKET SPLIT CALCULATION ==========

    /**
     * @notice Calculate the market split: find the boundary percentages and allowed amounts
     * @param marketId Market ID
     * @return negPct Negative boundary percentage
     * @return posPct Positive boundary percentage
     * @return negAmt Allowed amount at negative boundary
     * @return posAmt Allowed amount at positive boundary
     * @return valid True if a valid split was found
     */
    function calculateMarketSplit(uint256 marketId) public view returns (
        uint256 negPct, uint256 posPct, uint256 negAmt, uint256 posAmt, bool valid
    ) {
        // Build sorted array of non-zero percentages
        uint256 count = 0;
        for (uint256 i = 0; i <= 100; i++) {
            if (percentageTotals[marketId][i] > 0) count++;
        }

        if (count < 2) return (0, 0, 0, 0, false);

        uint256[] memory pcts = new uint256[](count);
        uint256[] memory amts = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i <= 100; i++) {
            if (percentageTotals[marketId][i] > 0) {
                pcts[idx] = i;
                amts[idx] = percentageTotals[marketId][i];
                idx++;
            }
        }

        uint256 total = marketPools[marketId];

        if (count == 2) {
            return _calculateTwoElement(pcts, amts, total);
        }

        return _normalizedCalculate(pcts, amts, count, total);
    }

    /**
     * @dev Handle 2-element edge cases (0% and 100% boundaries)
     */
    function _calculateTwoElement(
        uint256[] memory pcts,
        uint256[] memory amts,
        uint256 total
    ) internal pure returns (uint256 negPct, uint256 posPct, uint256 negAmt, uint256 posAmt, bool valid) {
        uint256 negPercentage = pcts[0];
        uint256 posPercentage = pcts[1];
        uint256 negAmount = amts[0];
        uint256 posAmount = amts[1];

        if (negPercentage == 0) {
            // Negative side bets on negative no matter what
            if (posPercentage == 100) {
                // Both sides don't care about odds
                return (0, 100, negAmount, posAmount, true);
            } else {
                // Positive side cares about odds
                // Max positive allowed: (100 - pPos) * sum(neg) / pPos
                uint256 maxPosAmount = ((100 - posPercentage) * negAmount) / posPercentage;
                if (posAmount <= maxPosAmount) {
                    return (0, posPercentage, negAmount, posAmount, true);
                } else {
                    return (0, posPercentage, negAmount, maxPosAmount, true);
                }
            }
        } else if (posPercentage == 100) {
            // Negative side cares, positive doesn't
            // Max negative allowed: pNeg * sum(pos) / (100 - pNeg)
            uint256 maxNegAmount = (negPercentage * posAmount) / (100 - negPercentage);
            if (negAmount <= maxNegAmount) {
                return (negPercentage, 100, negAmount, posAmount, true);
            } else {
                return (negPercentage, 100, maxNegAmount, posAmount, true);
            }
        } else {
            // No extreme bets, use normalized calculation
            return _normalizedCalculate(pcts, amts, 2, total);
        }
    }

    /**
     * @dev Main split calculation for general case
     */
    function _normalizedCalculate(
        uint256[] memory pcts,
        uint256[] memory amts,
        uint256 count,
        uint256 total
    ) internal pure returns (uint256, uint256, uint256, uint256, bool) {
        uint256 negativeTotal = 0;
        uint256 positiveTotal = total;

        for (uint256 i = 0; i < count - 1; i++) {
            negativeTotal += amts[i];
            positiveTotal -= amts[i];

            // Check if positive side satisfies negative side's desire:
            // 0% bettors are unconditionally negative, no constraint on positive side
            uint256 desiredMinPos = pcts[i] == 0 ? 0 : (pcts[i] * negativeTotal) / (100 - pcts[i]);

            if (positiveTotal >= desiredMinPos) {
                // Check if negative side satisfies positive side's desire:
                // 100% bettors are unconditionally positive, no constraint on negative side
                uint256 desiredMinNeg = pcts[i + 1] == 100 ? 0 : (pcts[i + 1] * positiveTotal) / (100 - pcts[i + 1]);

                if (negativeTotal >= desiredMinNeg) {
                    // Both sides satisfied
                    return (pcts[i], pcts[i + 1], amts[i], amts[i + 1], true);
                } else {
                    // Negative side too low - continue to grow it
                    if (i == count - 2) {
                        // Last iteration: cap positive side
                        return (pcts[i], pcts[i + 1], amts[i], desiredMinPos, true);
                    }
                    // else continue loop
                }
            } else {
                // Positive side too low (negative too high) - reverse calculate
                return _reverseCalculate(pcts, amts, i, negativeTotal, positiveTotal);
            }
        }

        return (0, 0, 0, 0, false);
    }

    /**
     * @dev Walk backwards to find how much of the negative side to keep
     */
    function _reverseCalculate(
        uint256[] memory pcts,
        uint256[] memory amts,
        uint256 negativeIndex,
        uint256 negativeTotal,
        uint256 positiveTotal
    ) internal pure returns (uint256, uint256, uint256, uint256, bool) {
        // 100% bettors accept any odds, no need to trim negative side
        if (pcts[negativeIndex + 1] == 100) {
            return (pcts[negativeIndex], 100, amts[negativeIndex], amts[negativeIndex + 1], true);
        }

        // Max negative allowed: (100 - pPos) * sum(pos) / pPos
        uint256 desiredMaxNeg = ((100 - pcts[negativeIndex + 1]) * positiveTotal) / pcts[negativeIndex + 1];

        uint256 negAmount = negativeTotal;
        for (uint256 i = negativeIndex + 1; i > 0; i--) {
            if (negAmount - amts[i - 1] < desiredMaxNeg) {
                // Stop here - this percentage is the boundary
                uint256 allowed = desiredMaxNeg - (negAmount - amts[i - 1]);
                if (allowed > amts[i - 1]) allowed = amts[i - 1];
                return (pcts[i - 1], pcts[negativeIndex + 1], allowed, amts[negativeIndex + 1], true);
            }
            negAmount -= amts[i - 1];
        }

        return (0, 0, 0, 0, false);
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
        LockRefundInfo storage lockInfo = lockRefunds[marketId];

        // Bets between boundaries are refunded, not winners
        if (predicted > lockInfo.negativePercentage && predicted < lockInfo.positivePercentage) {
            return false;
        }

        if (market.positiveOutcome) {
            // Positive wins: bets at or above positive boundary
            return predicted >= lockInfo.positivePercentage;
        } else {
            // Negative wins: bets at or below negative boundary
            return predicted <= lockInfo.negativePercentage;
        }
    }

    /**
     * @notice Get refund amount for a predictor (between boundaries/cancelled/abandoned)
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

        // Bets between boundaries get full refund when market is locked or resolved
        if (
            (market.status == MarketStatus.Locked || market.status == MarketStatus.Resolved)
        ) {
            LockRefundInfo storage lockInfo = lockRefunds[marketId];
            uint256 pct = prediction.percentage;
            if (pct > lockInfo.negativePercentage && pct < lockInfo.positivePercentage) {
                return prediction.amount;
            }
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
     * @notice Internal lock implementation using split boundaries
     * @param marketId Market ID
     * @param negPct Negative boundary percentage
     * @param posPct Positive boundary percentage
     * @param negAmt Allowed amount at negative boundary
     * @param posAmt Allowed amount at positive boundary
     */
    function _lockWithSplit(uint256 marketId, uint256 negPct, uint256 posPct, uint256 negAmt, uint256 posAmt) internal {
        Market storage market = markets[marketId];

        // Store split info
        LockRefundInfo storage lockInfo = lockRefunds[marketId];
        lockInfo.negativePercentage = negPct;
        lockInfo.positivePercentage = posPct;
        lockInfo.negativeAllowedAmount = negAmt;
        lockInfo.positiveAllowedAmount = posAmt;

        // Calculate total refund amount to subtract from pool
        uint256 totalRefund = 0;

        // Partial refund at negative boundary
        uint256 negActual = percentageTotals[marketId][negPct];
        if (negActual > negAmt) {
            totalRefund += negActual - negAmt;
        }

        // Partial refund at positive boundary
        uint256 posActual = percentageTotals[marketId][posPct];
        if (posActual > posAmt) {
            totalRefund += posActual - posAmt;
        }

        // Full refund for percentages between boundaries
        for (uint256 i = negPct + 1; i < posPct; i++) {
            totalRefund += percentageTotals[marketId][i];
        }

        marketPools[marketId] -= totalRefund;

        // Store equilibrium for oracle resolution compatibility
        market.equilibrium = negPct;
        market.status = MarketStatus.Locked;

        emit MarketLocked(marketId, negPct);
    }

    /**
     * @notice Get effective amount for a predictor after lock refunds
     * @param marketId Market ID
     * @param amount Original prediction amount
     * @param percentage Predicted percentage
     * @return Effective amount after partial refund
     */
    function _getEffectiveAmount(uint256 marketId, uint256 amount, uint256 percentage) internal view returns (uint256) {
        LockRefundInfo storage lockInfo = lockRefunds[marketId];

        // Partial refund at negative boundary
        if (percentage == lockInfo.negativePercentage) {
            uint256 actualTotal = percentageTotals[marketId][percentage];
            if (actualTotal > lockInfo.negativeAllowedAmount) {
                return (amount * lockInfo.negativeAllowedAmount) / actualTotal;
            }
        }

        // Partial refund at positive boundary
        if (percentage == lockInfo.positivePercentage) {
            uint256 actualTotal = percentageTotals[marketId][percentage];
            if (actualTotal > lockInfo.positiveAllowedAmount) {
                return (amount * lockInfo.positiveAllowedAmount) / actualTotal;
            }
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
        LockRefundInfo storage lockInfo = lockRefunds[marketId];
        uint256 totalWinningBets = 0;
        bool positive = market.positiveOutcome;

        for (uint256 i = 0; i <= 100; i++) {
            uint256 amount = percentageTotals[marketId][i];
            if (amount == 0) continue;

            // Skip bets between boundaries (they are refunded)
            if (i > lockInfo.negativePercentage && i < lockInfo.positivePercentage) continue;

            bool isWinning;
            if (positive) {
                isWinning = i >= lockInfo.positivePercentage;
            } else {
                isWinning = i <= lockInfo.negativePercentage;
            }

            if (isWinning) {
                totalWinningBets += _getEffectiveAmount(marketId, amount, i);
            }
        }

        return totalWinningBets;
    }

    /**
     * @notice Get distributable pool (total pool minus all refunds already subtracted during lock)
     * @param marketId Market ID
     * @return Distributable pool amount
     */
    function _getDistributablePool(uint256 marketId) internal view returns (uint256) {
        return marketPools[marketId];
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

    /// @notice Authorized resolver address (can resolve oracle markets directly)
    address public authorizedResolver;

    /**
     * @dev Storage gap for future upgrades (reduced from 45 to 44)
     */
    uint256[44] private __gap;
}
