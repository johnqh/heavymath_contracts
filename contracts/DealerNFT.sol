// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title DealerNFT
 * @notice NFT-based dealer licensing system with category/subcategory permissions
 * @dev UUPS upgradeable pattern with permission management using 0xFF wildcards
 *
 * Permission System:
 * - Dealers receive an NFT license (tokenId)
 * - Each license has permissions for category/subcategory combinations
 * - 0xFF wildcard: category=0xFF means "all categories", subcategory=0xFF means "all subcategories"
 * - Permissions are additive across multiple setPermissions calls
 *
 * Example:
 * - setPermissions(tokenId, 1, [1,2,3]) → allows category 1, subcategories 1,2,3
 * - setPermissions(tokenId, 0xFF, [0xFF]) → allows all categories and subcategories
 * - setPermissions(tokenId, 5, [0xFF]) → allows category 5 with any subcategory
 */
contract DealerNFT is
    Initializable,
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    /// @notice Wildcard value for "all" categories or subcategories
    uint256 public constant WILDCARD = 0xFF;

    /// @notice Permissions mapping: tokenId → category → subcategories[]
    mapping(uint256 => mapping(uint256 => uint256[])) private _permissions;

    /// @notice Track which categories have been set for a token (for hasPermissions check)
    mapping(uint256 => uint256[]) private _categoriesSet;

    /// @notice Emitted when a license NFT is issued
    event LicenseIssued(uint256 indexed tokenId, address indexed dealer);

    /// @notice Emitted when permissions are set for a license
    event PermissionsSet(uint256 indexed tokenId, uint256 category, uint256[] subCategories);

    /// @notice Emitted when a license is transferred
    event LicenseTransferred(uint256 indexed tokenId, address indexed from, address indexed to);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract (replaces constructor for upgradeable contracts)
     */
    function initialize() public initializer {
        __ERC721_init("DealerLicense", "DLICENSE");
        __ERC721Enumerable_init();
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
    }

    /**
     * @notice Mint a new dealer license NFT
     * @param to Address to receive the NFT
     * @param tokenId Token ID for the new license
     */
    function mint(address to, uint256 tokenId) external onlyOwner {
        _safeMint(to, tokenId);
        emit LicenseIssued(tokenId, to);
    }

    /**
     * @notice Set permissions for a category on a license
     * @param tokenId The license token ID
     * @param category The category (or 0xFF for all categories)
     * @param subCategories Array of subcategories (or [0xFF] for all subcategories)
     */
    function setPermissions(
        uint256 tokenId,
        uint256 category,
        uint256[] calldata subCategories
    ) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");

        // Store permissions
        _permissions[tokenId][category] = subCategories;

        // Track that this category has been set
        bool categoryExists = false;
        uint256[] storage categories = _categoriesSet[tokenId];
        for (uint256 i = 0; i < categories.length; i++) {
            if (categories[i] == category) {
                categoryExists = true;
                break;
            }
        }
        if (!categoryExists) {
            _categoriesSet[tokenId].push(category);
        }

        emit PermissionsSet(tokenId, category, subCategories);
    }

    /**
     * @notice Check if a token has any permissions set
     * @param tokenId The license token ID
     * @return True if permissions have been set
     */
    function hasPermissions(uint256 tokenId) external view returns (bool) {
        return _categoriesSet[tokenId].length > 0;
    }

    /**
     * @notice Validate if a license has permission for a specific category/subcategory
     * @param tokenId The license token ID
     * @param category The category to check
     * @param subCategory The subcategory to check
     * @return True if the license has permission
     *
     * @dev Permission logic:
     * 1. If category=0xFF is set with subCategory=0xFF → allow all
     * 2. If category matches and has subCategory=0xFF → allow all subcategories for that category
     * 3. If category matches and subCategory is in the array → allow specific combination
     */
    function validatePermission(
        uint256 tokenId,
        uint256 category,
        uint256 subCategory
    ) external view returns (bool) {
        // Check for wildcard: all categories, all subcategories
        uint256[] storage wildcardSubs = _permissions[tokenId][WILDCARD];
        if (wildcardSubs.length > 0) {
            for (uint256 i = 0; i < wildcardSubs.length; i++) {
                if (wildcardSubs[i] == WILDCARD) {
                    return true; // Full wildcard permission
                }
            }
        }

        // Check for specific category permissions
        uint256[] storage subCategories = _permissions[tokenId][category];
        if (subCategories.length == 0) {
            return false; // No permissions for this category
        }

        // Check if subcategory matches
        for (uint256 i = 0; i < subCategories.length; i++) {
            if (subCategories[i] == WILDCARD || subCategories[i] == subCategory) {
                return true;
            }
        }

        return false;
    }

    /**
     * @notice Hook that is called after any token transfer
     * @dev Emits LicenseTransferred event
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable) returns (address) {
        address from = _ownerOf(tokenId);
        address previousOwner = super._update(to, tokenId, auth);

        // Only emit transfer event if not minting (from != address(0))
        if (from != address(0) && to != address(0)) {
            emit LicenseTransferred(tokenId, from, to);
        }

        return previousOwner;
    }

    /**
     * @notice Hook to increase the balance before token transfer
     */
    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable)
    {
        super._increaseBalance(account, value);
    }

    /**
     * @notice Check if contract supports an interface
     */
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, ERC721EnumerableUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    /**
     * @notice Authorize upgrade (only owner can upgrade)
     * @dev Required by UUPSUpgradeable
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /**
     * @dev Storage gap for future upgrades
     * Reserves 50 storage slots for future variables without shifting existing storage
     */
    uint256[50] private __gap;
}
