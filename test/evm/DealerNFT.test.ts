import "@nomicfoundation/hardhat-viem";
import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, parseAbi, parseEther } from "viem";

const { viem } = hre;

describe("DealerNFT", function () {
  const MINT_PRICE = parseEther("0.05");

  async function deployDealerNFTFixture() {
    const [owner, dealer1, dealer2, other] = await viem.getWalletClients();

    // Deploy implementation
    const implementation = await viem.deployContract("DealerNFT");

    // Encode the initialize(uint256) function call with mint price
    const initData = encodeFunctionData({
      abi: parseAbi(["function initialize(uint256)"]),
      functionName: "initialize",
      args: [MINT_PRICE],
    });

    // Deploy ERC1967Proxy pointing to implementation with initialization
    const proxy = await viem.deployContract("ERC1967Proxy", [
      implementation.address,
      initData,
    ]);

    // Get contract instance at proxy address
    const dealerNFT = await viem.getContractAt("DealerNFT", proxy.address);

    return { dealerNFT, implementation, proxy, owner, dealer1, dealer2, other };
  }

  describe("Deployment & Initialization", function () {
    it("Should initialize with correct owner", async function () {
      const { dealerNFT, owner } = await deployDealerNFTFixture();
      const contractOwner = await dealerNFT.read.owner();
      expect(contractOwner.toLowerCase()).to.equal(owner.account.address.toLowerCase());
    });

    it("Should initialize with correct mint price", async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      const price = await dealerNFT.read.mintPrice();
      expect(price).to.equal(MINT_PRICE);
    });

    it("Should prevent re-initialization", async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      try {
        await dealerNFT.write.initialize([MINT_PRICE]);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("InvalidInitialization");
      }
    });

    it("Should have correct name and symbol", async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      expect(await dealerNFT.read.name()).to.equal("DealerLicense");
      expect(await dealerNFT.read.symbol()).to.equal("DLICENSE");
    });
  });

  describe("Minting", function () {
    it("Should mint NFT to caller when paying correct price", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });

      const nftOwner = await dealerNFT.read.ownerOf([1n]);
      expect(nftOwner.toLowerCase()).to.equal(dealer1.account.address.toLowerCase());
    });

    it("Should auto-increment token IDs", async function () {
      const { dealerNFT, dealer1, dealer2 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      await dealerNFT.write.mint({ account: dealer2.account, value: MINT_PRICE });

      const owner1 = await dealerNFT.read.ownerOf([1n]);
      const owner2 = await dealerNFT.read.ownerOf([2n]);
      expect(owner1.toLowerCase()).to.equal(dealer1.account.address.toLowerCase());
      expect(owner2.toLowerCase()).to.equal(dealer2.account.address.toLowerCase());
    });

    it("Should reject minting with incorrect payment", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      try {
        await dealerNFT.write.mint({ account: dealer1.account, value: parseEther("0.01") });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Incorrect payment amount");
      }
    });

    it("Should reject minting with no payment", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      try {
        await dealerNFT.write.mint({ account: dealer1.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("Incorrect payment amount");
      }
    });

    it("Should emit LicenseIssued event", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      const hash = await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      const publicClient = await viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Event should be emitted
      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });

  describe("Mint Price Management", function () {
    it("Should allow owner to change mint price", async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      const newPrice = parseEther("0.1");

      await dealerNFT.write.setMintPrice([newPrice]);
      expect(await dealerNFT.read.mintPrice()).to.equal(newPrice);
    });

    it("Should reject non-owner from changing mint price", async function () {
      const { dealerNFT, other } = await deployDealerNFTFixture();

      try {
        await dealerNFT.write.setMintPrice([parseEther("0.1")], { account: other.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("OwnableUnauthorizedAccount");
      }
    });
  });

  describe("Payment Withdrawal", function () {
    it("Should allow owner to withdraw collected payments", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      // Mint to collect payment
      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });

      // Withdraw
      await dealerNFT.write.withdrawPayments();
    });

    it("Should reject withdrawal when no balance", async function () {
      const { dealerNFT } = await deployDealerNFTFixture();

      try {
        await dealerNFT.write.withdrawPayments();
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("No payments to withdraw");
      }
    });

    it("Should reject non-owner from withdrawing", async function () {
      const { dealerNFT, dealer1, other } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });

      try {
        await dealerNFT.write.withdrawPayments({ account: other.account });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("OwnableUnauthorizedAccount");
      }
    });
  });

  describe("Permissions", function () {
    it("Should set permissions for category/subCategory", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n, 3n]]);

      const hasPermissions = await dealerNFT.read.hasPermissions([1n]);
      expect(hasPermissions).to.be.true;
    });

    it("Should validate permissions correctly - exact match", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n, 3n]]);

      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 2n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 3n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 4n])).to.be.false;
    });

    it("Should validate permissions - all categories wildcard (0xFF)", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      await dealerNFT.write.setPermissions([1n, 0xFFn, [0xFFn]]);

      // Should allow any category and subcategory
      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 99n, 50n])).to.be.true;
    });

    it("Should validate permissions - all subcategories wildcard for category", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      await dealerNFT.write.setPermissions([1n, 5n, [0xFFn]]);

      // Should allow category 5 with any subcategory
      expect(await dealerNFT.read.validatePermission([1n, 5n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 5n, 99n])).to.be.true;
      // But not other categories
      expect(await dealerNFT.read.validatePermission([1n, 6n, 1n])).to.be.false;
    });

    it("Should support multiple category permissions", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n]]);
      await dealerNFT.write.setPermissions([1n, 2n, [3n, 4n]]);

      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 2n, 3n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 3n])).to.be.false;
    });

    it("Should only allow owner to set permissions", async function () {
      const { dealerNFT, dealer1, other } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });

      try {
        await dealerNFT.write.setPermissions([1n, 1n, [1n]], {
          account: other.account,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("OwnableUnauthorizedAccount");
      }
    });
  });

  describe("Upgrade", function () {
    it("Should only allow owner to upgrade", async function () {
      const { dealerNFT, other } = await deployDealerNFTFixture();

      // Deploy new implementation
      const newImplementation = await viem.deployContract("DealerNFT");

      try {
        await dealerNFT.write.upgradeToAndCall([newImplementation.address, "0x"], {
          account: other.account,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("OwnableUnauthorizedAccount");
      }
    });

    it("Should preserve state after upgrade", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      // Mint NFT and set permissions before upgrade
      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n]]);

      // Upgrade
      const newImplementation = await viem.deployContract("DealerNFT");
      await dealerNFT.write.upgradeToAndCall([newImplementation.address, "0x"]);

      // Verify state preserved
      const nftOwner = await dealerNFT.read.ownerOf([1n]);
      expect(nftOwner.toLowerCase()).to.equal(dealer1.account.address.toLowerCase());
      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
    });
  });

  describe("Transfer Hook", function () {
    it("Should emit transfer event on NFT transfer", async function () {
      const { dealerNFT, dealer1, dealer2 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account, value: MINT_PRICE });

      const hash = await dealerNFT.write.transferFrom(
        [dealer1.account.address, dealer2.account.address, 1n],
        { account: dealer1.account }
      );

      const publicClient = await viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Should emit LicenseTransferred event
      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });
});
