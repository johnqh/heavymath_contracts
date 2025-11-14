// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title OracleResolver
 * @notice Handles oracle-based resolution for prediction markets
 * @dev UUPS upgradeable contract that integrates with Chainlink and other oracles
 *
 * Supported Oracle Types:
 * 1. Chainlink Price Feeds - For price-based markets
 * 2. Manual Oracle - For custom data sources (sports, weather, etc.)
 * 3. Chainlink Any API - For external API data (future)
 *
 * Resolution Process:
 * - Oracle data is converted to 0-100 percentage range
 * - Data must be validated and within acceptable bounds
 * - Stale data protection with configurable timeouts
 */
contract OracleResolver is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
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

    /// @notice Events
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
     * @notice Mark oracle data as used for resolution
     * @param oracleId Oracle identifier
     */
    function markResolved(bytes32 oracleId) external {
        // This should only be called by PredictionMarket contract
        // In production, add access control
        latestData[oracleId].isResolved = true;
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
     * @dev Storage gap for future upgrades
     */
    uint256[50] private __gap;
}
