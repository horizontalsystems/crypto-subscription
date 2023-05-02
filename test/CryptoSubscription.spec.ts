import { expect, use } from 'chai'
import { ethers } from 'hardhat'
import { FakeContract, smock } from '@defi-wonderland/smock'
import { Wallet } from 'ethers'
import { CryptoSubscription, IERC20Metadata } from '../typechain-types'
import { dayToSeconds, toTokenAmount } from './helpers'
import { time } from '@nomicfoundation/hardhat-network-helpers'

use(smock.matchers)

describe('CryptoSubscription', function () {
  let contract: CryptoSubscription
  let paymentToken: FakeContract<IERC20Metadata>
  let paymentTokenDecimals = 6

  let rateMultiplier = 1000

  let duration1 = 30
  let cost1 = 200
  let duration2 = 90
  let cost2 = 500
  let duration3 = 180
  let cost3 = 800

  let durations = [duration1, duration2, duration3]
  let costs = [cost1, cost2, cost3]

  let owner: Wallet
  let moderator: Wallet
  let subscriber1: Wallet
  let subscriber2: Wallet
  let promoCodeOwner: Wallet
  let other: Wallet

  beforeEach(async () => {
    ;[owner, moderator, subscriber1, subscriber2, promoCodeOwner, other] = await (ethers as any).getSigners()

    paymentToken = await smock.fake('IERC20Metadata')
    paymentToken.decimals.whenCalledWith().returns(paymentTokenDecimals)

    const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription', { signer: owner })
    contract = await CryptoSubscription.deploy(paymentToken.address, durations, costs)

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

    it('sets initial plans', async () => {
      expect(await contract.plans()).to.deep.eq([durations, costs])
    })
  })

  describe('#stateInfo', () => {
    it('returns state info', async () => {
      expect(await contract.stateInfo()).to.deep.eq([paymentToken.address, durations, costs])
    })
  })

  describe('#addressInfo', () => {
    it('returns address info for admin', async () => {
      expect(await contract.addressInfo(owner.address)).to.deep.eq([false, true, 0])
    })

    it('returns address info for moderator', async () => {
      expect(await contract.addressInfo(moderator.address)).to.deep.eq([true, false, 0])
    })

    it('returns address info for subscriber', async () => {
      let deadline = await mockSubscriptionDuration(subscriber1, 20)

      expect(await contract.addressInfo(subscriber1.address)).to.deep.eq([false, false, deadline])
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
          .to.emit(contract, 'PaymentTokenChange')
          .withArgs(paymentToken.address, otherPaymentToken.address, other.address, amount)
      })
    })
  })

  describe('#withdraw', () => {
    let amount = toTokenAmount(800, paymentTokenDecimals)

    beforeEach(async () => {
      paymentToken.balanceOf.whenCalledWith(contract.address).returns(amount)
    })

    it('reverts if called by non-default admin role', async () => {
      await expect(contract.connect(moderator).withdraw()).to.be.reverted
    })

    it('transfers all tokens from contract to owner address', async () => {
      await contract.connect(owner).withdraw()
      expect(paymentToken.transfer).to.have.been.calledOnceWith(owner.address, amount)
    })
  })

  describe('#updatePlans', () => {
    let updatedDurations = [duration1, duration2, 60]
    let updatedCosts = [400, 0, 700]
    let invalidDurations = [duration1, duration2, 0]
    let expectedDurations = [duration1, duration3, 60]
    let expectedCosts = [400, cost3, 700]

    it('reverts if called by non-moderator role', async () => {
      await expect(contract.connect(other).updatePlans(updatedDurations, updatedCosts)).to.be.reverted
    })

    it('reverts if called with zero duration', async () => {
      await expect(contract.connect(moderator).updatePlans(invalidDurations, updatedCosts)).to.be.revertedWithCustomError(
        contract,
        'ZeroDuration'
      )
    })

    it('merges current plans with provided ones', async () => {
      await contract.connect(moderator).updatePlans(updatedDurations, updatedCosts)
      expect(await contract.plans()).to.deep.eq([expectedDurations, expectedCosts])
    })
  })

  describe('#whitelist', () => {
    let duration = 15

    it('reverts if called by non-moderator role', async () => {
      await expect(contract.connect(other).whitelist(subscriber1.address, duration)).to.be.reverted
    })

    it('emits event on whitelist', async () => {
      await expect(contract.connect(moderator).whitelist(subscriber1.address, duration))
        .to.emit(contract, 'Whitelist')
        .withArgs(subscriber1.address, duration)
    })

    describe('for new subscriber', () => {
      it('sets deadline to duration time starting from block time', async () => {
        let currentTimestamp = (await time.latest()) + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        await contract.connect(moderator).whitelist(subscriber1.address, duration)

        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration))
      })
    })

    describe('for existing non-expired subscriber', () => {
      it('adds duration to deadline', async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        await time.setNextBlockTimestamp(expirationTimestamp - 1)

        await contract.connect(moderator).whitelist(subscriber1.address, duration)

        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expirationTimestamp + dayToSeconds(duration))
      })
    })

    describe('for existing expired subscriber', () => {
      it('sets deadline to duration time starting from block time', async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        let currentTimestamp = expirationTimestamp + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        await contract.connect(moderator).whitelist(subscriber1.address, duration)

        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration))
      })
    })
  })

  describe('#setPromoCode', () => {
    let promoCodeName = 'Promo Code'
    let commissionRate = 0.025 * rateMultiplier
    let discountRate = 0.015 * rateMultiplier
    let duration = 30

    it('reverts if called by non-moderator role', async () => {
      await expect(contract.connect(other).setPromoCode(subscriber1.address, promoCodeName, commissionRate, discountRate, duration)).to.be
        .reverted
    })

    it('reverts if promo code is empty', async () => {
      await expect(
        contract.connect(moderator).setPromoCode(subscriber1.address, '', commissionRate, discountRate, duration)
      ).to.be.revertedWithCustomError(contract, 'EmptyPromoCode')
    })

    it('reverts if promo code does already exist', async () => {
      await contract.connect(moderator).setPromoCode(subscriber1.address, promoCodeName, commissionRate, discountRate, duration)

      await expect(contract.connect(moderator).setPromoCode(subscriber2.address, promoCodeName, commissionRate, discountRate, duration))
        .to.be.revertedWithCustomError(contract, 'PromoCodeAlreadyExists')
        .withArgs(promoCodeName)
    })

    it('adds promo codes for provided data', async () => {
      let promoCodeName2 = 'Promo Code 2'
      let commissionRate2 = 0.05 * rateMultiplier
      let discountRate2 = 0.03 * rateMultiplier
      let duration2 = 15

      let promoCodeName3 = 'Promo Code 3'
      let commissionRate3 = 0.08 * rateMultiplier
      let discountRate3 = 0.06 * rateMultiplier
      let duration3 = 45

      let blockTimestamp = (await time.latest()) + 1
      await time.setNextBlockTimestamp(blockTimestamp)
      await contract.connect(moderator).setPromoCode(subscriber1.address, promoCodeName, commissionRate, discountRate, duration)

      let blockTimestamp2 = (await time.latest()) + 1
      await time.setNextBlockTimestamp(blockTimestamp2)
      await contract.connect(moderator).setPromoCode(subscriber1.address, promoCodeName2, commissionRate2, discountRate2, duration2)

      let blockTimestamp3 = (await time.latest()) + 1
      await time.setNextBlockTimestamp(blockTimestamp3)
      await contract.connect(moderator).setPromoCode(subscriber2.address, promoCodeName3, commissionRate3, discountRate3, duration3)

      expect(await contract.promoCodes(subscriber1.address)).to.deep.eq([promoCodeName, promoCodeName2])
      expect(await contract.promoCodes(subscriber2.address)).to.deep.eq([promoCodeName3])

      let promoCode = await contract.promoCode(promoCodeName)
      expect(promoCode).to.have.property('_address', subscriber1.address)
      expect(promoCode).to.have.property('commissionRate', commissionRate)
      expect(promoCode).to.have.property('discountRate', discountRate)
      expect(promoCode).to.have.property('deadline', blockTimestamp + dayToSeconds(duration))

      let promoCode2 = await contract.promoCode(promoCodeName2)
      expect(promoCode2).to.have.property('_address', subscriber1.address)
      expect(promoCode2).to.have.property('commissionRate', commissionRate2)
      expect(promoCode2).to.have.property('discountRate', discountRate2)
      expect(promoCode2).to.have.property('deadline', blockTimestamp2 + dayToSeconds(duration2))

      let promoCode3 = await contract.promoCode(promoCodeName3)
      expect(promoCode3).to.have.property('_address', subscriber2.address)
      expect(promoCode3).to.have.property('commissionRate', commissionRate3)
      expect(promoCode3).to.have.property('discountRate', discountRate3)
      expect(promoCode3).to.have.property('deadline', blockTimestamp3 + dayToSeconds(duration3))

      let promoCodesSubscriber1 = await contract.promoCodesInfo(subscriber1.address)
      expect(promoCodesSubscriber1[0]).to.have.property('_address', subscriber1.address)
      expect(promoCodesSubscriber1[0]).to.have.property('commissionRate', commissionRate)
      expect(promoCodesSubscriber1[0]).to.have.property('discountRate', discountRate)
      expect(promoCodesSubscriber1[0]).to.have.property('deadline', blockTimestamp + dayToSeconds(duration))
      expect(promoCodesSubscriber1[1]).to.have.property('_address', subscriber1.address)
      expect(promoCodesSubscriber1[1]).to.have.property('commissionRate', commissionRate2)
      expect(promoCodesSubscriber1[1]).to.have.property('discountRate', discountRate2)
      expect(promoCodesSubscriber1[1]).to.have.property('deadline', blockTimestamp2 + dayToSeconds(duration2))

      let promoCodesSubscriber2 = await contract.promoCodesInfo(subscriber2.address)
      expect(promoCodesSubscriber2[0]).to.have.property('_address', subscriber2.address)
      expect(promoCodesSubscriber2[0]).to.have.property('commissionRate', commissionRate3)
      expect(promoCodesSubscriber2[0]).to.have.property('discountRate', discountRate3)
      expect(promoCodesSubscriber2[0]).to.have.property('deadline', blockTimestamp3 + dayToSeconds(duration3))
    })

    it('emits event on addition', async () => {
      let blockTimestamp = (await time.latest()) + 1
      await time.setNextBlockTimestamp(blockTimestamp)

      await expect(contract.connect(moderator).setPromoCode(subscriber1.address, promoCodeName, commissionRate, discountRate, duration))
        .to.emit(contract, 'PromoCodeAddition')
        .withArgs(subscriber1.address, promoCodeName, commissionRate, discountRate, blockTimestamp + dayToSeconds(duration))
    })
  })

  describe('#subscribe', () => {
    it('reverts if plan does not exist', async () => {
      let invalidDuration = 20
      await expect(contract.connect(subscriber1).subscribe(invalidDuration))
        .to.be.revertedWithCustomError(contract, 'InvalidPlan')
        .withArgs(invalidDuration)
    })

    it('transfers payment tokens from subscriber to contract address', async () => {
      await contract.connect(subscriber1).subscribe(duration1)

      expect(paymentToken.transferFrom).to.have.been.calledOnceWith(
        subscriber1.address,
        contract.address,
        toTokenAmount(cost1, paymentTokenDecimals)
      )
    })

    it('emits event on subscription', async () => {
      await expect(contract.connect(subscriber1).subscribe(duration1))
        .to.emit(contract, 'Subscription')
        .withArgs(subscriber1.address, duration1, cost1)
    })

    describe('for new subscriber', () => {
      it('sets deadline to duration time starting from block time', async () => {
        let currentTimestamp = (await time.latest()) + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        await contract.connect(subscriber1).subscribe(duration1)

        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration1))
      })
    })

    describe('for existing non-expired subscriber', () => {
      it('adds duration to deadline', async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        await time.setNextBlockTimestamp(expirationTimestamp - 1)

        await contract.connect(subscriber1).subscribe(duration2)

        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expirationTimestamp + dayToSeconds(duration2))
      })
    })

    describe('for existing expired subscriber', () => {
      it('sets deadline to duration time starting from block time', async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        let currentTimestamp = expirationTimestamp + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        await contract.connect(subscriber1).subscribe(duration2)

        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration2))
      })
    })
  })

  describe.only('#subscribeWithPromoCode', () => {
    let promoCodeName = 'Promo Code'
    let commissionRate = 0.025
    let discountRate = 0.015
    let duration = 90

    describe('with valid promo code', () => {
      beforeEach(async () => {
        await contract
          .connect(moderator)
          .setPromoCode(promoCodeOwner.address, promoCodeName, commissionRate * rateMultiplier, discountRate * rateMultiplier, duration)
      })

      it('reverts if plan does not exist', async () => {
        let invalidDuration = 20
        await expect(contract.connect(subscriber1).subscribeWithPromoCode(invalidDuration, promoCodeName))
          .to.be.revertedWithCustomError(contract, 'InvalidPlan')
          .withArgs(invalidDuration)
      })

      it('transfers payment tokens to contract and promo code owner', async () => {
        await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)

        expect(paymentToken.transferFrom).to.have.been.calledTwice
        expect(paymentToken.transferFrom.atCall(0)).to.have.been.calledWith(
          subscriber1.address,
          promoCodeOwner.address,
          toTokenAmount(cost1 * commissionRate, paymentTokenDecimals)
        )
        expect(paymentToken.transferFrom.atCall(1)).to.have.been.calledWith(
          subscriber1.address,
          contract.address,
          toTokenAmount(cost1 - cost1 * (commissionRate + discountRate), paymentTokenDecimals)
        )
      })

      it('emits event on subscription', async () => {
        await expect(contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName))
          .to.emit(contract, 'SubscriptionWithPromoCode')
          .withArgs(subscriber1.address, promoCodeName, duration1, cost1)
      })

      describe('for new subscriber', () => {
        it('sets deadline to duration time starting from block time', async () => {
          let currentTimestamp = (await time.latest()) + 1
          await time.setNextBlockTimestamp(currentTimestamp)

          await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)

          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration1))
        })
      })

      describe('for existing non-expired subscriber', () => {
        it('adds duration to deadline', async () => {
          let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
          await time.setNextBlockTimestamp(expirationTimestamp - 1)

          await contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCodeName)

          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expirationTimestamp + dayToSeconds(duration2))
        })
      })

      describe('for existing expired subscriber', () => {
        it('sets deadline to duration time starting from block time', async () => {
          let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
          let currentTimestamp = expirationTimestamp + 1
          await time.setNextBlockTimestamp(currentTimestamp)

          await contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCodeName)

          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration2))
        })
      })
    })

    describe('with expired promo code', () => {
      beforeEach(async () => {
        let blockTimestamp = (await time.latest()) + 1
        await time.setNextBlockTimestamp(blockTimestamp)

        await contract
          .connect(moderator)
          .setPromoCode(promoCodeOwner.address, promoCodeName, commissionRate * rateMultiplier, discountRate * rateMultiplier, duration)

        await time.setNextBlockTimestamp(blockTimestamp + dayToSeconds(duration) + 1)
      })

      it('reverts if promo code is expired', async () => {
        await expect(contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName))
          .to.be.revertedWithCustomError(contract, 'ExpiredPromoCode')
          .withArgs(promoCodeName)
      })
    })

    describe('with invalid promo code', () => {
      let invalidPromoCode = 'Invalid promo code'

      it('reverts if promo code does not exist', async () => {
        await expect(contract.connect(subscriber1).subscribeWithPromoCode(duration1, invalidPromoCode))
          .to.be.revertedWithCustomError(contract, 'InvalidPromoCode')
          .withArgs(invalidPromoCode)
      })
    })
  })

  async function mockSubscriptionDuration(signer: Wallet, duration: number) {
    let subscriptionTimestamp = (await time.latest()) + 1

    await time.setNextBlockTimestamp(subscriptionTimestamp)
    await contract.connect(moderator).whitelist(signer.address, duration)

    return subscriptionTimestamp + dayToSeconds(duration)
  }
})
