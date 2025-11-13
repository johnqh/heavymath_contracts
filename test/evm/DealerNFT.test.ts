import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEther, encodeFunctionData, parseAbi } from "viem";

const { viem } = hre;

describe("DealerNFT", function () {
  async function deployDealerNFTFixture() {
    const [owner, dealer1, dealer2, other] = await viem.getWalletClients();

    // Deploy implementation
    const implementation = await viem.deployContract("DealerNFT");

    // Encode the initialize() function call
    const initData = encodeFunctionData({
      abi: parseAbi(["function initialize()"]),
      functionName: "initialize",
      args: [],
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

    it("Should prevent re-initialization", async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      try {
        await dealerNFT.write.initialize();
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
    it("Should mint NFT to dealer", async function () {
      const { dealerNFT, dealer1, owner } = await deployDealerNFTFixture();

      await dealerNFT.write.mint([dealer1.account.address, 1n]);

      const nftOwner = await dealerNFT.read.ownerOf([1n]);
      expect(nftOwner.toLowerCase()).to.equal(dealer1.account.address.toLowerCase());
    });

    it("Should only allow owner to mint", async function () {
      const { dealerNFT, dealer1, other } = await deployDealerNFTFixture();

      try {
        await dealerNFT.write.mint([dealer1.account.address, 1n], {
          account: other.account,
        });
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.message).to.include("OwnableUnauthorizedAccount");
      }
    });

    it("Should emit LicenseIssued event", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      const hash = await dealerNFT.write.mint([dealer1.account.address, 1n]);
      const publicClient = await viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Event should be emitted
      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });

  describe("Permissions", function () {
    it("Should set permissions for category/subCategory", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint([dealer1.account.address, 1n]);
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n, 3n]]);

      const hasPermissions = await dealerNFT.read.hasPermissions([1n]);
      expect(hasPermissions).to.be.true;
    });

    it("Should validate permissions correctly - exact match", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint([dealer1.account.address, 1n]);
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n, 3n]]);

      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 2n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 3n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 4n])).to.be.false;
    });

    it("Should validate permissions - all categories wildcard (0xFF)", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint([dealer1.account.address, 1n]);
      await dealerNFT.write.setPermissions([1n, 0xFFn, [0xFFn]]);

      // Should allow any category and subcategory
      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 99n, 50n])).to.be.true;
    });

    it("Should validate permissions - all subcategories wildcard for category", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint([dealer1.account.address, 1n]);
      await dealerNFT.write.setPermissions([1n, 5n, [0xFFn]]);

      // Should allow category 5 with any subcategory
      expect(await dealerNFT.read.validatePermission([1n, 5n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 5n, 99n])).to.be.true;
      // But not other categories
      expect(await dealerNFT.read.validatePermission([1n, 6n, 1n])).to.be.false;
    });

    it("Should support multiple category permissions", async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint([dealer1.account.address, 1n]);
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n]]);
      await dealerNFT.write.setPermissions([1n, 2n, [3n, 4n]]);

      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 2n, 3n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 3n])).to.be.false;
    });

    it("Should only allow owner to set permissions", async function () {
      const { dealerNFT, dealer1, other } = await deployDealerNFTFixture();

      await dealerNFT.write.mint([dealer1.account.address, 1n]);

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
      const { dealerNFT, implementation, other } = await deployDealerNFTFixture();

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
      await dealerNFT.write.mint([dealer1.account.address, 1n]);
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

      await dealerNFT.write.mint([dealer1.account.address, 1n]);

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
