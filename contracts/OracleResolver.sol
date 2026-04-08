// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/operatorforwarder/ChainlinkClient.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title OracleResolver
 * @notice Handles oracle-based resolution for prediction markets
 * @dev UUPS upgradeable contract that integrates with Chainlink Any API
 *
 * Supported Oracle Types:
 * 1. Chainlink Price Feeds - For price-based markets
 * 2. Manual Oracle - For custom data sources (sports, weather, etc.)
 * 3. Chainlink Any API - For external API data (sports game outcomes)
 *
 * Resolution Process (Chainlink Any API):
 * 1. requestResolution(marketId) sends a Chainlink request to the API
 * 2. Chainlink node calls the API endpoint and extracts the result
 * 3. fulfillResolution callback receives the result (0 or 1) and stores it
 * 4. PredictionMarket reads the result and resolves the market
 */
contract OracleResolver is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ChainlinkClient
{
    using Chainlink for Chainlink.Request;
    /// @notice Oracle type enum
    enum OracleType {
        Manual,        // No oracle, manual resolution only
        PriceFeed,     // Chainlink price feed
        CustomData     // Custom data source (manual updates by authorized updater)
    }

    /// @notice Oracle configuration
    struct OracleConfig {
        OracleType oracleType;
        address dataSource;      // Price feed address or zero for manual
        uint256 minValue;        // Minimum value for normalization
        uint256 maxValue;        // Maximum value for normalization
        uint256 stalePeriod;     // How long data is considered valid (seconds)
        bool isActive;           // Whether oracle is active
    }

    /// @notice Oracle data point
    struct OracleData {
        uint256 value;           // Raw oracle value
        uint256 percentage;      // Normalized to 0-100
        uint256 timestamp;       // When data was recorded
        bool isResolved;         // Whether this data point resolved a market
    }

    /// @notice Mapping: oracleId => OracleConfig
    mapping(bytes32 => OracleConfig) public oracles;

    /// @notice Mapping: oracleId => OracleData
    mapping(bytes32 => OracleData) public latestData;

    /// @notice Mapping: updater => authorized
    mapping(address => bool) public authorizedUpdaters;

    /// @notice Address of the PredictionMarket contract (authorized to call markResolved)
    address public predictionMarket;

    // ========== Chainlink Any API Configuration ==========

    /// @notice Chainlink oracle node address
    address public chainlinkOracle;

    /// @notice Chainlink job ID for HTTP GET → uint256
    bytes32 public chainlinkJobId;

    /// @notice LINK fee per Chainlink request
    uint256 public chainlinkFee;

    /// @notice Base URL for the resolve API endpoint (e.g., "https://api.heavymath.io/api/markets/")
    string public apiBaseUrl;

    /// @notice Mapping: Chainlink requestId → on-chain marketId
    mapping(bytes32 => uint256) public requestToMarketId;

    /// @notice Mapping: Chainlink requestId → chainId (for URL construction)
    mapping(bytes32 => uint256) public requestToChainId;

    /// @notice Mapping: Chainlink requestId → oracleId (to store result in latestData)
    mapping(bytes32 => bytes32) public requestToOracleId;

    /// @notice Mapping: marketId → has a pending Chainlink request
    mapping(uint256 => bool) public pendingResolution;

    // ========== Events ==========

    event OracleRegistered(
        bytes32 indexed oracleId,
        OracleType oracleType,
        address dataSource,
        uint256 minValue,
        uint256 maxValue
    );

    event OracleDataUpdated(
        bytes32 indexed oracleId,
        uint256 value,
        uint256 percentage,
        uint256 timestamp
    );

    event UpdaterAuthorized(address indexed updater, bool authorized);
    event PredictionMarketSet(address indexed predictionMarket);

    event ResolutionRequested(
        uint256 indexed marketId,
        bytes32 indexed requestId,
        bytes32 oracleId
    );

    event ResolutionFulfilled(
        uint256 indexed marketId,
        bytes32 indexed requestId,
        uint256 result
    );

    event ChainlinkConfigUpdated(
        address oracle,
        bytes32 jobId,
        uint256 fee,
        string apiBaseUrl
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract
     */
    function initialize() public initializer {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
    }

    /**
     * @notice Register a new oracle
     * @param oracleId Unique identifier for the oracle
     * @param oracleType Type of oracle
     * @param dataSource Address of data source (for price feeds)
     * @param minValue Minimum value for normalization
     * @param maxValue Maximum value for normalization
     * @param stalePeriod How long data is considered valid
     */
    function registerOracle(
        bytes32 oracleId,
        OracleType oracleType,
        address dataSource,
        uint256 minValue,
        uint256 maxValue,
        uint256 stalePeriod
    ) external onlyOwner {
        require(!oracles[oracleId].isActive, "Oracle already registered");
        require(maxValue > minValue, "Invalid range");

        oracles[oracleId] = OracleConfig({
            oracleType: oracleType,
            dataSource: dataSource,
            minValue: minValue,
            maxValue: maxValue,
            stalePeriod: stalePeriod,
            isActive: true
        });

        emit OracleRegistered(
            oracleId,
            oracleType,
            dataSource,
            minValue,
            maxValue
        );
    }

    /**
     * @notice Update oracle data (for CustomData type)
     * @param oracleId Oracle identifier
     * @param value Raw value to record
     */
    function updateOracleData(bytes32 oracleId, uint256 value) external {
        OracleConfig storage config = oracles[oracleId];
        require(config.isActive, "Oracle not active");
        require(
            config.oracleType == OracleType.CustomData,
            "Not custom data oracle"
        );
        require(
            authorizedUpdaters[msg.sender] || msg.sender == owner(),
            "Not authorized"
        );

        uint256 percentage = _normalizeToPercentage(
            value,
            config.minValue,
            config.maxValue
        );

        latestData[oracleId] = OracleData({
            value: value,
            percentage: percentage,
            timestamp: block.timestamp,
            isResolved: false
        });

        emit OracleDataUpdated(oracleId, value, percentage, block.timestamp);
    }

    /**
     * @notice Get current oracle data
     * @param oracleId Oracle identifier
     * @return percentage Normalized percentage (0-100)
     * @return timestamp When data was recorded
     * @return isValid Whether data is still valid (not stale)
     */
    function getOracleData(bytes32 oracleId)
        external
        view
        returns (
            uint256 percentage,
            uint256 timestamp,
            bool isValid
        )
    {
        OracleConfig storage config = oracles[oracleId];
        require(config.isActive, "Oracle not active");

        OracleData storage data = latestData[oracleId];

        // Check if data is stale
        bool isValid_ = (block.timestamp - data.timestamp) <= config.stalePeriod;

        return (data.percentage, data.timestamp, isValid_);
    }

    /**
     * @notice Set the PredictionMarket contract address (authorized to call markResolved)
     * @param _predictionMarket Address of the PredictionMarket contract
     */
    function setPredictionMarket(address _predictionMarket) external onlyOwner {
        require(_predictionMarket != address(0), "Invalid address");
        require(_predictionMarket.code.length > 0, "Address is not a contract");
        predictionMarket = _predictionMarket;
        emit PredictionMarketSet(_predictionMarket);
    }

    /**
     * @notice Mark oracle data as used for resolution
     * @param oracleId Oracle identifier
     */
    function markResolved(bytes32 oracleId) external {
        require(
            msg.sender == predictionMarket || msg.sender == owner(),
            "Not authorized"
        );
        latestData[oracleId].isResolved = true;
    }

    /**
     * @notice Register an oracle for a market (called by PredictionMarket during market creation)
     * @param oracleId Oracle identifier to register
     * @dev Skips silently if already registered. Only callable by PredictionMarket or owner.
     */
    function registerOracleForMarket(bytes32 oracleId) external {
        require(
            msg.sender == predictionMarket || msg.sender == owner(),
            "Not authorized"
        );
        if (oracles[oracleId].isActive) return;

        oracles[oracleId] = OracleConfig({
            oracleType: OracleType.CustomData,
            dataSource: address(0),
            minValue: 0,
            maxValue: 1,
            stalePeriod: 365 days,
            isActive: true
        });

        emit OracleRegistered(oracleId, OracleType.CustomData, address(0), 0, 1);
    }

    /**
     * @notice Authorize/deauthorize an updater
     * @param updater Address to authorize
     * @param authorized Whether to authorize or deauthorize
     */
    function setAuthorizedUpdater(address updater, bool authorized)
        external
        onlyOwner
    {
        authorizedUpdaters[updater] = authorized;
        emit UpdaterAuthorized(updater, authorized);
    }

    /**
     * @notice Deactivate an oracle
     * @param oracleId Oracle identifier
     */
    function deactivateOracle(bytes32 oracleId) external onlyOwner {
        oracles[oracleId].isActive = false;
    }

    /**
     * @notice Normalize a value to 0-100 percentage
     * @param value Raw value
     * @param minValue Minimum bound
     * @param maxValue Maximum bound
     * @return Percentage (0-100)
     */
    function _normalizeToPercentage(
        uint256 value,
        uint256 minValue,
        uint256 maxValue
    ) internal pure returns (uint256) {
        // Clamp value to range
        if (value <= minValue) return 0;
        if (value >= maxValue) return 100;

        // Normalize: (value - min) * 100 / (max - min)
        return ((value - minValue) * 100) / (maxValue - minValue);
    }

    // ========== Chainlink Any API Functions ==========

    /**
     * @notice Configure Chainlink Any API parameters
     * @param _linkToken Address of the LINK token contract
     * @param _oracle Address of the Chainlink oracle node
     * @param _jobId Job ID for HTTP GET → uint256
     * @param _fee LINK fee per request (in wei)
     * @param _apiBaseUrl Base URL for the resolve endpoint (e.g., "https://api.heavymath.io/api/markets/")
     */
    function setChainlinkConfig(
        address _linkToken,
        address _oracle,
        bytes32 _jobId,
        uint256 _fee,
        string calldata _apiBaseUrl
    ) external onlyOwner {
        require(_linkToken != address(0), "Invalid LINK token");
        require(_oracle != address(0), "Invalid oracle");

        _setChainlinkToken(_linkToken);
        chainlinkOracle = _oracle;
        chainlinkJobId = _jobId;
        chainlinkFee = _fee;
        apiBaseUrl = _apiBaseUrl;

        emit ChainlinkConfigUpdated(_oracle, _jobId, _fee, _apiBaseUrl);
    }

    /**
     * @notice Request oracle resolution via Chainlink Any API
     * @param marketId The on-chain market ID
     * @param oracleId The market's oracleId (used to store the result)
     * @return requestId The Chainlink request ID
     * @dev Called by PredictionMarket.requestOracleResolution()
     */
    function requestResolution(
        uint256 marketId,
        bytes32 oracleId
    ) external returns (bytes32) {
        require(
            msg.sender == predictionMarket || msg.sender == owner(),
            "Not authorized"
        );
        require(!pendingResolution[marketId], "Resolution already pending");
        require(chainlinkOracle != address(0), "Chainlink not configured");

        Chainlink.Request memory req = _buildChainlinkRequest(
            chainlinkJobId,
            address(this),
            this.fulfillResolution.selector
        );

        // Build URL: {apiBaseUrl}{chainId}-{marketId}/resolve
        string memory url = string(
            abi.encodePacked(
                apiBaseUrl,
                Strings.toString(block.chainid),
                "-",
                Strings.toString(marketId),
                "/resolve"
            )
        );

        req._add("get", url);
        req._add("path", "result");
        req._addInt("times", 1);

        bytes32 requestId = _sendChainlinkRequestTo(chainlinkOracle, req, chainlinkFee);

        requestToMarketId[requestId] = marketId;
        requestToChainId[requestId] = block.chainid;
        requestToOracleId[requestId] = oracleId;
        pendingResolution[marketId] = true;

        emit ResolutionRequested(marketId, requestId, oracleId);

        return requestId;
    }

    /**
     * @notice Chainlink callback - called by oracle with the API result
     * @param requestId The Chainlink request ID
     * @param result The extracted result from the API (0 = negative, 1 = positive)
     */
    function fulfillResolution(
        bytes32 requestId,
        uint256 result
    ) public recordChainlinkFulfillment(requestId) {
        uint256 marketId = requestToMarketId[requestId];
        bytes32 oracleId = requestToOracleId[requestId];
        require(marketId != 0, "Unknown request");
        require(result <= 1, "Invalid result");

        pendingResolution[marketId] = false;

        // Store result in latestData so PredictionMarket can read it
        // result=1 → percentage=100 (positive), result=0 → percentage=0 (negative)
        latestData[oracleId] = OracleData({
            value: result,
            percentage: result * 100,
            timestamp: block.timestamp,
            isResolved: false
        });

        emit ResolutionFulfilled(marketId, requestId, result);
    }

    /**
     * @notice Withdraw LINK tokens from the contract (owner only)
     * @param to Address to send LINK tokens to
     * @param amount Amount of LINK to withdraw
     */
    function withdrawLink(address to, uint256 amount) external onlyOwner {
        LinkTokenInterface link = LinkTokenInterface(_chainlinkTokenAddress());
        require(link.transfer(to, amount), "LINK transfer failed");
    }

    /**
     * @notice Authorize upgrade (only owner can upgrade)
     * @dev Required by UUPSUpgradeable
     */
    function _authorizeUpgrade(address newImplementation)
        internal
        override
        onlyOwner
    {}

    /**
     * @dev Storage gap for future upgrades (reduced from 50 to account for new storage vars)
     */
    uint256[42] private __gap;
}
