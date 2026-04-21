import '@nomicfoundation/hardhat-viem';
import { expect } from 'chai';
import hre from 'hardhat';
import { encodeFunctionData, parseAbi, parseUnits } from 'viem';

const { viem } = hre;

const USDC_DECIMALS = 6;
const MINT_PRICE = parseUnits('50', USDC_DECIMALS); // 50 USDC

describe('DealerNFT', function () {
  async function deployDealerNFTFixture() {
    const [owner, dealer1, dealer2, other] = await viem.getWalletClients();

    // Deploy MockUSDC
    const usdc = await viem.deployContract('MockUSDC');

    // Deploy implementation
    const implementation = await viem.deployContract('DealerNFT');

    // Encode the initialize(uint256) function call with mint price
    const initData = encodeFunctionData({
      abi: parseAbi(['function initialize(uint256)']),
      functionName: 'initialize',
      args: [MINT_PRICE],
    });

    // Deploy ERC1967Proxy pointing to implementation with initialization
    const proxy = await viem.deployContract('ERC1967Proxy', [
      implementation.address,
      initData,
    ]);

    // Get contract instance at proxy address
    const dealerNFT = await viem.getContractAt('DealerNFT', proxy.address);

    // Set USDC as stake token
    await dealerNFT.write.setStakeToken([usdc.address]);

    // Mint USDC to dealers and approve
    const mintAmount = parseUnits('10000', USDC_DECIMALS);
    for (const wallet of [dealer1, dealer2, other]) {
      await usdc.write.mint([wallet.account.address, mintAmount], {
        account: owner.account,
      });
      await usdc.write.approve([dealerNFT.address, mintAmount], {
        account: wallet.account,
      });
    }

    return {
      dealerNFT,
      usdc,
      implementation,
      proxy,
      owner,
      dealer1,
      dealer2,
      other,
    };
  }

  describe('Deployment & Initialization', function () {
    it('Should initialize with correct owner', async function () {
      const { dealerNFT, owner } = await deployDealerNFTFixture();
      const contractOwner = await dealerNFT.read.owner();
      expect(contractOwner.toLowerCase()).to.equal(
        owner.account.address.toLowerCase()
      );
    });

    it('Should initialize with correct mint price', async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      const price = await dealerNFT.read.mintPrice();
      expect(price).to.equal(MINT_PRICE);
    });

    it('Should prevent re-initialization', async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      try {
        await dealerNFT.write.initialize([MINT_PRICE]);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('InvalidInitialization');
      }
    });

    it('Should have correct name and symbol', async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      expect(await dealerNFT.read.name()).to.equal('DealerLicense');
      expect(await dealerNFT.read.symbol()).to.equal('DLICENSE');
    });

    it('Should have stakeToken set', async function () {
      const { dealerNFT, usdc } = await deployDealerNFTFixture();
      const stakeToken = await dealerNFT.read.stakeToken();
      expect(stakeToken.toLowerCase()).to.equal(usdc.address.toLowerCase());
    });
  });

  describe('Minting', function () {
    it('Should mint NFT to caller when USDC is approved', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });

      const nftOwner = await dealerNFT.read.ownerOf([1n]);
      expect(nftOwner.toLowerCase()).to.equal(
        dealer1.account.address.toLowerCase()
      );
    });

    it('Should deduct USDC from minter', async function () {
      const { dealerNFT, usdc, dealer1 } = await deployDealerNFTFixture();
      const balanceBefore = await usdc.read.balanceOf([
        dealer1.account.address,
      ]);

      await dealerNFT.write.mint({ account: dealer1.account });

      const balanceAfter = await usdc.read.balanceOf([dealer1.account.address]);
      expect(balanceBefore - balanceAfter).to.equal(MINT_PRICE);
    });

    it('Should auto-increment token IDs', async function () {
      const { dealerNFT, dealer1, dealer2 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });
      await dealerNFT.write.mint({ account: dealer2.account });

      const owner1 = await dealerNFT.read.ownerOf([1n]);
      const owner2 = await dealerNFT.read.ownerOf([2n]);
      expect(owner1.toLowerCase()).to.equal(
        dealer1.account.address.toLowerCase()
      );
      expect(owner2.toLowerCase()).to.equal(
        dealer2.account.address.toLowerCase()
      );
    });

    it('Should reject minting without USDC approval', async function () {
      const { dealerNFT, usdc, other } = await deployDealerNFTFixture();

      // Give USDC but revoke approval
      await usdc.write.approve([dealerNFT.address, 0n], {
        account: other.account,
      });

      try {
        await dealerNFT.write.mint({ account: other.account });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('revert');
      }
    });

    it('Should reject minting without stakeToken set', async function () {
      const [, dealer1] = await viem.getWalletClients();
      const implementation = await viem.deployContract('DealerNFT');
      const initData = encodeFunctionData({
        abi: parseAbi(['function initialize(uint256)']),
        functionName: 'initialize',
        args: [MINT_PRICE],
      });
      const proxy = await viem.deployContract('ERC1967Proxy', [
        implementation.address,
        initData,
      ]);
      const dealerNFT = await viem.getContractAt('DealerNFT', proxy.address);

      try {
        await dealerNFT.write.mint({ account: dealer1.account });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('Payment token not set');
      }
    });

    it('Should emit LicenseIssued event', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      const hash = await dealerNFT.write.mint({ account: dealer1.account });
      const publicClient = await viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });

  describe('Mint Price Management', function () {
    it('Should allow owner to change mint price', async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      const newPrice = parseUnits('100', USDC_DECIMALS);

      await dealerNFT.write.setMintPrice([newPrice]);
      expect(await dealerNFT.read.mintPrice()).to.equal(newPrice);
    });

    it('Should reject non-owner from changing mint price', async function () {
      const { dealerNFT, other } = await deployDealerNFTFixture();

      try {
        await dealerNFT.write.setMintPrice([parseUnits('100', USDC_DECIMALS)], {
          account: other.account,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('OwnableUnauthorizedAccount');
      }
    });
  });

  describe('Stake Token Management', function () {
    it('Should allow owner to set stake token', async function () {
      const { dealerNFT, usdc } = await deployDealerNFTFixture();
      const stakeToken = await dealerNFT.read.stakeToken();
      expect(stakeToken.toLowerCase()).to.equal(usdc.address.toLowerCase());
    });

    it('Should reject zero address', async function () {
      const { dealerNFT } = await deployDealerNFTFixture();
      try {
        await dealerNFT.write.setStakeToken([
          '0x0000000000000000000000000000000000000000',
        ]);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('Zero address');
      }
    });

    it('Should reject non-owner', async function () {
      const { dealerNFT, usdc, other } = await deployDealerNFTFixture();
      try {
        await dealerNFT.write.setStakeToken([usdc.address], {
          account: other.account,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('OwnableUnauthorizedAccount');
      }
    });
  });

  describe('Payment Withdrawal', function () {
    it('Should allow owner to withdraw collected USDC', async function () {
      const { dealerNFT, usdc, owner, dealer1 } =
        await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });

      const ownerBalanceBefore = await usdc.read.balanceOf([
        owner.account.address,
      ]);
      await dealerNFT.write.withdrawPayments();
      const ownerBalanceAfter = await usdc.read.balanceOf([
        owner.account.address,
      ]);

      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(MINT_PRICE);
    });

    it('Should reject withdrawal when no balance', async function () {
      const { dealerNFT } = await deployDealerNFTFixture();

      try {
        await dealerNFT.write.withdrawPayments();
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('No payments to withdraw');
      }
    });

    it('Should reject non-owner from withdrawing', async function () {
      const { dealerNFT, dealer1, other } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });

      try {
        await dealerNFT.write.withdrawPayments({ account: other.account });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('OwnableUnauthorizedAccount');
      }
    });
  });

  describe('Permissions', function () {
    it('Should set permissions for category/subCategory', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n, 3n]]);

      const hasPermissions = await dealerNFT.read.hasPermissions([1n]);
      expect(hasPermissions).to.be.true;
    });

    it('Should validate permissions correctly - exact match', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n, 3n]]);

      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 2n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 3n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 4n])).to.be.false;
    });

    it('Should validate permissions - all categories wildcard (0xFF)', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });
      await dealerNFT.write.setPermissions([1n, 0xffn, [0xffn]]);

      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 99n, 50n])).to.be
        .true;
    });

    it('Should validate permissions - all subcategories wildcard for category', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });
      await dealerNFT.write.setPermissions([1n, 5n, [0xffn]]);

      expect(await dealerNFT.read.validatePermission([1n, 5n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 5n, 99n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 6n, 1n])).to.be.false;
    });

    it('Should support multiple category permissions', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n]]);
      await dealerNFT.write.setPermissions([1n, 2n, [3n, 4n]]);

      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 2n, 3n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 3n])).to.be.false;
    });

    it('Should only allow owner to set permissions', async function () {
      const { dealerNFT, dealer1, other } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });

      try {
        await dealerNFT.write.setPermissions([1n, 1n, [1n]], {
          account: other.account,
        });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('OwnableUnauthorizedAccount');
      }
    });
  });

  describe('Default Permissions', function () {
    it('Should apply default permissions on mint', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.setDefaultPermissions([0xffn, [0xffn]]);
      await dealerNFT.write.mint({ account: dealer1.account });

      expect(await dealerNFT.read.hasPermissions([1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
      expect(await dealerNFT.read.validatePermission([1n, 99n, 50n])).to.be
        .true;
    });
  });

  describe('Upgrade', function () {
    it('Should only allow owner to upgrade', async function () {
      const { dealerNFT, other } = await deployDealerNFTFixture();

      const newImplementation = await viem.deployContract('DealerNFT');

      try {
        await dealerNFT.write.upgradeToAndCall(
          [newImplementation.address, '0x'],
          { account: other.account }
        );
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).to.include('OwnableUnauthorizedAccount');
      }
    });

    it('Should preserve state after upgrade', async function () {
      const { dealerNFT, dealer1 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });
      await dealerNFT.write.setPermissions([1n, 1n, [1n, 2n]]);

      const newImplementation = await viem.deployContract('DealerNFT');
      await dealerNFT.write.upgradeToAndCall([newImplementation.address, '0x']);

      const nftOwner = await dealerNFT.read.ownerOf([1n]);
      expect(nftOwner.toLowerCase()).to.equal(
        dealer1.account.address.toLowerCase()
      );
      expect(await dealerNFT.read.validatePermission([1n, 1n, 1n])).to.be.true;
    });
  });

  describe('Transfer Hook', function () {
    it('Should emit transfer event on NFT transfer', async function () {
      const { dealerNFT, dealer1, dealer2 } = await deployDealerNFTFixture();

      await dealerNFT.write.mint({ account: dealer1.account });

      const hash = await dealerNFT.write.transferFrom(
        [dealer1.account.address, dealer2.account.address, 1n],
        { account: dealer1.account }
      );

      const publicClient = await viem.getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      expect(receipt.logs.length).to.be.greaterThan(0);
    });
  });
});
