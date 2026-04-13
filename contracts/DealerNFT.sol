// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DealerNFT
 * @notice NFT-based dealer licensing system with category/subcategory permissions
 * @dev UUPS upgradeable pattern with permission management using 0xFF wildcards
 *
 * Anyone can mint a dealer license by paying the mint price in USDC (or other ERC20).
 * The owner can update the mint price, set the payment token, and withdraw collected fees.
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

    /// @notice Price to mint a dealer license in wei
    uint256 public mintPrice;

    /// @notice Auto-incrementing token ID counter
    uint256 private _nextTokenId;

    /// @notice Permissions mapping: tokenId → category → subcategories[]
    mapping(uint256 => mapping(uint256 => uint256[])) private _permissions;

    /// @notice Track which categories have been set for a token (for hasPermissions check)
    mapping(uint256 => uint256[]) private _categoriesSet;

    /// @notice Default permission category applied to newly minted tokens
    uint256 public defaultPermissionCategory;

    /// @notice Default permission subcategories applied to newly minted tokens
    uint256[] public defaultPermissionSubCategories;

    /// @notice ERC20 token used for mint payment (e.g., USDC)
    IERC20 public stakeToken;

    /// @notice Emitted when a license NFT is issued
    event LicenseIssued(uint256 indexed tokenId, address indexed dealer);

    /// @notice Emitted when permissions are set for a license
    event PermissionsSet(uint256 indexed tokenId, uint256 category, uint256[] subCategories);

    /// @notice Emitted when a license is transferred
    event LicenseTransferred(uint256 indexed tokenId, address indexed from, address indexed to);

    /// @notice Emitted when the mint price is updated
    event MintPriceUpdated(uint256 oldPrice, uint256 newPrice);

    /// @notice Emitted when default permissions are updated
    event DefaultPermissionsUpdated(uint256 category, uint256[] subCategories);

    /// @notice Emitted when the stake token is updated
    event StakeTokenUpdated(address indexed token);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the contract (replaces constructor for upgradeable contracts)
     * @param _mintPrice Initial mint price in wei
     */
    function initialize(uint256 _mintPrice) public initializer {
        __ERC721_init("DealerLicense", "DLICENSE");
        __ERC721Enumerable_init();
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        mintPrice = _mintPrice;
        _nextTokenId = 1;
    }

    /**
     * @notice Set default permissions applied to newly minted tokens (only owner)
     * @param category The default category (e.g. 1 for SPORTS, or 0xFF for all)
     * @param subCategories The default subcategories (e.g. [0xFF] for all)
     */
    function setDefaultPermissions(
        uint256 category,
        uint256[] calldata subCategories
    ) external onlyOwner {
        defaultPermissionCategory = category;
        delete defaultPermissionSubCategories;
        for (uint256 i = 0; i < subCategories.length; i++) {
            defaultPermissionSubCategories.push(subCategories[i]);
        }
        emit DefaultPermissionsUpdated(category, subCategories);
    }

    /**
     * @notice Set the ERC20 payment token address (only owner)
     * @param _stakeToken Address of the ERC20 token (e.g., USDC)
     */
    function setStakeToken(address _stakeToken) external onlyOwner {
        require(_stakeToken != address(0), "Zero address");
        stakeToken = IERC20(_stakeToken);
        emit StakeTokenUpdated(_stakeToken);
    }

    /**
     * @notice Mint a new dealer license NFT by paying the mint price in USDC
     * @dev Caller must approve stakeToken transfer before calling. Copies defaultPermissions if set.
     */
    function mint() external {
        require(address(stakeToken) != address(0), "Payment token not set");
        if (mintPrice > 0) {
            require(stakeToken.transferFrom(msg.sender, address(this), mintPrice), "Payment failed");
        }

        uint256 tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);

        // Copy default permissions if set
        if (defaultPermissionSubCategories.length > 0) {
            uint256 cat = defaultPermissionCategory;
            uint256[] storage subs = defaultPermissionSubCategories;
            uint256[] storage dest = _permissions[tokenId][cat];
            for (uint256 i = 0; i < subs.length; i++) {
                dest.push(subs[i]);
            }
            _categoriesSet[tokenId].push(cat);
            emit PermissionsSet(tokenId, cat, subs);
        }

        emit LicenseIssued(tokenId, msg.sender);
    }

    /**
     * @notice Update the mint price (only owner)
     * @param newPrice New mint price in stakeToken base units (e.g., 50_000000 for $50 USDC)
     */
    function setMintPrice(uint256 newPrice) external onlyOwner {
        uint256 oldPrice = mintPrice;
        mintPrice = newPrice;
        emit MintPriceUpdated(oldPrice, newPrice);
    }

    /**
     * @notice Withdraw collected stakeToken payments to the owner (only owner)
     */
    function withdrawPayments() external onlyOwner {
        require(address(stakeToken) != address(0), "Payment token not set");
        uint256 balance = stakeToken.balanceOf(address(this));
        require(balance > 0, "No payments to withdraw");
        require(stakeToken.transfer(owner(), balance), "Transfer failed");
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

        // Check if category already tracked before overwriting
        bool categoryExists = _permissions[tokenId][category].length > 0;

        // Store permissions
        _permissions[tokenId][category] = subCategories;

        // Track that this category has been set (O(1) check via existing permissions)
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
     * @dev Storage gap for future upgrades.
     * Reduced from 50 to 47 after adding defaultPermissionCategory (1 slot),
     * defaultPermissionSubCategories (1 slot for dynamic array base),
     * and stakeToken (1 slot).
     */
    uint256[47] private __gap;
}
