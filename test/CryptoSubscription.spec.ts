import { expect, use } from 'chai'
import { ethers } from 'hardhat'
import { FakeContract, smock } from '@defi-wonderland/smock'
import { Wallet } from 'ethers'
import { CryptoSubscription, IERC20Metadata } from '../typechain-types'
import { toTokenAmount } from './helpers'

use(smock.matchers)

describe('CryptoSubscription', function () {
  let contract: CryptoSubscription
  let paymentToken: FakeContract<IERC20Metadata>
  let paymentTokenDecimals = 6

  let rateMultiplier = 1000

  let commissionRate = 0.025
  let discountRate = 0.015

  let plans: { [key: number]: number } = { 30: 200, 90: 500, 180: 800 }

  let owner: Wallet
  let moderator: Wallet
  let other: Wallet

  beforeEach(async () => {
    ;[owner, moderator, other] = await (ethers as any).getSigners()

    paymentToken = await smock.fake('IERC20Metadata')
    paymentToken.decimals.whenCalledWith().returns(paymentTokenDecimals)

    const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription', { signer: owner })
    contract = await CryptoSubscription.deploy(
      paymentToken.address,
      commissionRate * rateMultiplier,
      discountRate * rateMultiplier,
      Object.keys(plans),
      Object.values(plans)
    )

    let moderatorRole = await contract.MODERATOR_ROLE()
    await contract.grantRole(moderatorRole, moderator.address)
  })

  describe('#constructor', () => {
    it('grants owner default admin role', async () => {
      let defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE()
      expect(await contract.hasRole(defaultAdminRole, owner.address)).to.be.true
    })

    it('sets payment token to provided one', async () => {
      expect(await contract.paymentToken()).to.eq(paymentToken.address)
    })

    it('sets commission rate to provided one', async () => {
      expect(await contract.commissionRate()).to.eq(commissionRate * rateMultiplier)
    })

    it('sets discount rate to provided one', async () => {
      expect(await contract.discountRate()).to.eq(discountRate * rateMultiplier)
    })

    it('sets plans to provided ones', async () => {
      for (let duration in plans) {
        expect(await contract.planCost(duration)).to.eq(plans[duration])
      }
    })
  })

  describe('#updatePaymentToken', () => {
    let otherPaymentToken: FakeContract<IERC20Metadata>

    beforeEach(async () => {
      otherPaymentToken = await smock.fake('IERC20Metadata')
    })

    it('reverts if called by non-default admin role', async () => {
      await expect(contract.connect(moderator).changePaymentToken(otherPaymentToken.address, other.address)).to.be.reverted
    })

    it('changes payment token to new one', async () => {
      await contract.connect(owner).changePaymentToken(otherPaymentToken.address, other.address)
      expect(await contract.paymentToken()).to.eq(otherPaymentToken.address)
    })

    describe('withdraw whole balance of old payment token', () => {
      let amount = toTokenAmount(500, paymentTokenDecimals)

      beforeEach(async () => {
        paymentToken.balanceOf.whenCalledWith(contract.address).returns(amount)
      })

      it('transfers all tokens from contract to withdraw address', async () => {
        await contract.connect(owner).changePaymentToken(otherPaymentToken.address, other.address)
        expect(paymentToken.transfer).to.have.been.calledOnceWith(other.address, amount)
      })

      it('emits event when payment token changed', async () => {
        await expect(contract.connect(owner).changePaymentToken(otherPaymentToken.address, other.address))
          .to.emit(contract, 'PaymentTokenChanged')
          .withArgs(paymentToken.address, otherPaymentToken.address, other.address, amount)
      })
    })

    describe('#updateCommissionRate', () => {
      let newRate = 0.045
      let newContractRate = newRate * rateMultiplier

      it('reverts if called by non-default admin role', async () => {
        await expect(contract.connect(moderator).updateCommissionRate(newContractRate)).to.be.reverted
      })

      it('changes commission rate', async () => {
        await contract.connect(owner).updateCommissionRate(newContractRate)
        expect(await contract.commissionRate()).to.eq(newContractRate)
      })
    })

    describe('#updateDsicountRate', () => {
      let newRate = 0.035
      let newContractRate = newRate * rateMultiplier

      it('reverts if called by non-default admin role', async () => {
        await expect(contract.connect(moderator).updateDiscountRate(newContractRate)).to.be.reverted
      })

      it('changes discount rate', async () => {
        await contract.connect(owner).updateDiscountRate(newContractRate)
        expect(await contract.discountRate()).to.eq(newContractRate)
      })
    })
  })
})
