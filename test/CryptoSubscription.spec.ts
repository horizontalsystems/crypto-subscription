import { expect, use } from 'chai'
import { ethers } from 'hardhat'
import { FakeContract, smock } from '@defi-wonderland/smock'
import { BigNumber, Wallet } from 'ethers'
import { CryptoSubscription, IERC20Metadata } from '../typechain-types'
import { convertedAmount, dayToSeconds, toTokenAmount } from './helpers'
import { time } from '@nomicfoundation/hardhat-network-helpers'

use(smock.matchers)

describe('CryptoSubscription', function() {
  let contract: CryptoSubscription
  let contractDecimals = 2
  let rateMultiplier = 1000

  let paymentToken: FakeContract<IERC20Metadata>
  let paymentTokenDecimals = 6

  let duration1 = 30
  let cost1 = contractValue(89)
  let duration2 = 90
  let cost2 = contractValue(210)
  let duration3 = 180
  let cost3 = contractValue(320)

  let durations = [duration1, duration2, duration3]
  let costs = [cost1, cost2, cost3]

  let owner: Wallet
  let moderator: Wallet
  let subscriber1: Wallet
  let subscriber2: Wallet
  let promoCodeOwner: Wallet
  let promoCodeOwner2: Wallet
  let other: Wallet
  let other2: Wallet

  beforeEach(async () => {
    ;[owner, moderator, subscriber1, subscriber2, promoCodeOwner, promoCodeOwner2, other, other2] = await (ethers as any).getSigners()

    paymentToken = await smock.fake('IERC20Metadata')
    paymentToken.decimals.whenCalledWith().returns(paymentTokenDecimals)

    // required for SafeERC20
    paymentToken.transferFrom.returns(true)
    paymentToken.transfer.returns(true)

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

    it('reverts if payment token if not ERC20 contract', async () => {
      const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription', { signer: owner })
      await expect(CryptoSubscription.deploy(other.address, durations, costs)).to.be.reverted
    })

    it('sets payment token to provided one', async () => {
      expect(await contract.paymentToken()).to.eq(paymentToken.address)
    })

    it('sets initial plans', async () => {
      expect(await contract.planCost(duration1)).to.eq(cost1)
      expect(await contract.planCost(duration2)).to.eq(cost2)
      expect(await contract.planCost(duration3)).to.eq(cost3)
    })
  })

  describe('#addressInfo', () => {
    it('returns address info for admin', async () => {
      expect(await contract.addressInfo(owner.address)).to.deep.eq([false, true, 0, 0])
    })

    it('returns address info for moderator', async () => {
      expect(await contract.addressInfo(moderator.address)).to.deep.eq([true, false, 0, 0])
    })

    it('returns address info for subscriber', async () => {
      let deadline = await mockSubscriptionDuration(subscriber1, 20)

      expect(await contract.addressInfo(subscriber1.address)).to.deep.eq([false, false, deadline, 0])
    })

    it('returns address info for promoter', async () => {
      let expectedBalance = await mockPromoterBalance(promoCodeOwner, 'Promo')
      expect(await contract.addressInfo(promoCodeOwner.address)).to.deep.eq([false, false, 0, expectedBalance])
    })
  })

  describe('#changePaymentToken', () => {
    let newPaymentToken: FakeContract<IERC20Metadata>
    let newPaymentTokenDecimals = 18

    beforeEach(async () => {
      newPaymentToken = await smock.fake('IERC20Metadata')
      newPaymentToken.decimals.whenCalledWith().returns(newPaymentTokenDecimals)

      // required for SafeERC20
      newPaymentToken.transferFrom.returns(true)
    })

    it('reverts if called by non-default admin role', async () => {
      await expect(contract.connect(moderator).changePaymentToken(newPaymentToken.address, other.address, other2.address)).to.be.reverted
    })

    it('reverts if new payment token is not ERC20 contract', async () => {
      await expect(contract.connect(owner).changePaymentToken(moderator.address, other.address, other2.address)).to.be.reverted
    })

    it('changes payment token to new one', async () => {
      await contract.connect(owner).changePaymentToken(newPaymentToken.address, other.address, other2.address)
      expect(await contract.paymentToken()).to.eq(newPaymentToken.address)
    })

    describe('withdraw balance of old payment token', () => {
      describe('for non-zero balance', () => {
        let amount = toTokenAmount(500, paymentTokenDecimals)

        beforeEach(async () => {
          paymentToken.balanceOf.whenCalledWith(contract.address).returns(amount)
        })

        it('transfers all tokens from contract to withdraw address', async () => {
          await contract.connect(owner).changePaymentToken(newPaymentToken.address, other.address, other2.address)
          expect(paymentToken.transfer).to.have.been.calledOnceWith(other.address, amount)
        })
      })

      describe('for zero balance', () => {
        beforeEach(async () => {
          paymentToken.balanceOf.whenCalledWith(contract.address).returns(0)
        })

        it('does not transfer any tokens from contract to withdraw address', async () => {
          await contract.connect(owner).changePaymentToken(newPaymentToken.address, other.address, other2.address)
          expect(paymentToken.transfer).to.have.not.been.called
        })
      })
    })

    describe('fulfill balance of new token', () => {
      describe('for non-zero total promoter balance', () => {
        let totalPromoterBalance = BigNumber.from(0)

        beforeEach(async () => {
          paymentToken.balanceOf.whenCalledWith(contract.address).returns(0)

          let balance1 = await mockPromoterBalance(promoCodeOwner, 'Promo 1')
          let balance2 = await mockPromoterBalance(promoCodeOwner2, 'Promo 2')

          totalPromoterBalance = balance1.add(balance2)
        })

        it('transfers total promoters balance to new payment token', async () => {
          await contract.connect(owner).changePaymentToken(newPaymentToken.address, other.address, other2.address)
          expect(newPaymentToken.transferFrom).to.have.been.calledOnceWith(
            other2.address,
            contract.address,
            convertedAmount(totalPromoterBalance, contractDecimals, newPaymentTokenDecimals)
          )
        })
      })

      describe('for zero total promoter balance', () => {
        beforeEach(async () => {
          paymentToken.balanceOf.whenCalledWith(contract.address).returns(0)
        })

        it('does not transfer any tokens to new payment token', async () => {
          await contract.connect(owner).changePaymentToken(newPaymentToken.address, other.address, other2.address)
          expect(newPaymentToken.transferFrom).to.have.not.been.called
        })
      })
    })

    it('emits event when payment token changed', async () => {
      await expect(contract.connect(owner).changePaymentToken(newPaymentToken.address, other.address, other2.address))
        .to.emit(contract, 'PaymentTokenChange')
        .withArgs(paymentToken.address, newPaymentToken.address)
    })
  })

  describe('#withdraw', () => {
    let amount = toTokenAmount(800, paymentTokenDecimals)

    beforeEach(async () => {
      paymentToken.balanceOf.whenCalledWith(contract.address).returns(amount)
    })

    it('reverts if called by non-default admin role', async () => {
      await expect(contract.connect(moderator).withdraw(other.address)).to.be.reverted
    })

    it('transfers all tokens except total promoters balance from contract to withdraw address', async () => {
      let balance1 = await mockPromoterBalance(promoCodeOwner, 'Promo 1')
      let balance2 = await mockPromoterBalance(promoCodeOwner2, 'Promo 2')

      let totalPromoterBalance = convertedAmount(balance1.add(balance2), contractDecimals, paymentTokenDecimals)
      let expectedAmount = amount.sub(totalPromoterBalance)

      await contract.connect(owner).withdraw(other.address)

      expect(paymentToken.transfer).to.have.been.calledOnceWith(other.address, expectedAmount)
    })
  })

  describe('#updatePlans', () => {
    let updatedDurations = [duration1, duration2, 60]
    let updatedCosts = [contractValue(400), 0, contractValue(700)]

    it('reverts if called by non-moderator role', async () => {
      await expect(contract.connect(other).updatePlans(updatedDurations, updatedCosts)).to.be.reverted
    })

    it('reverts if called with zero duration', async () => {
      await expect(contract.connect(moderator).updatePlans([duration1, duration2, 0], updatedCosts)).to.be.revertedWithCustomError(
        contract,
        'ZeroDuration'
      )
    })

    it('merges current plans with provided ones', async () => {
      await contract.connect(moderator).updatePlans(updatedDurations, updatedCosts)

      expect(await contract.planCost(duration1)).to.eq(contractValue(400))
      expect(await contract.planCost(duration2)).to.eq(0)
      expect(await contract.planCost(duration3)).to.eq(cost3)
      expect(await contract.planCost(60)).to.eq(contractValue(700))
    })
  })

  describe('#addSubscription', () => {
    let duration = 15

    it('reverts if called by non-moderator role', async () => {
      await expect(contract.connect(other).addSubscription(subscriber1.address, duration)).to.be.reverted
    })

    describe('for new subscriber', () => {
      let expectedDeadline = 0

      beforeEach(async () => {
        let currentTimestamp = (await time.latest()) + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        expectedDeadline = currentTimestamp + dayToSeconds(duration)
      })

      it('sets deadline to duration time starting from block time', async () => {
        await contract.connect(moderator).addSubscription(subscriber1.address, duration)
        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
      })

      it('emits event on add subscription', async () => {
        await expect(contract.connect(moderator).addSubscription(subscriber1.address, duration))
          .to.emit(contract, 'UpdateSubscription')
          .withArgs(subscriber1.address, duration, expectedDeadline)
      })
    })

    describe('for existing non-expired subscriber', () => {
      let expectedDeadline = 0

      beforeEach(async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        await time.setNextBlockTimestamp(expirationTimestamp - 1)

        expectedDeadline = expirationTimestamp + dayToSeconds(duration)
      })

      it('adds duration to deadline', async () => {
        await contract.connect(moderator).addSubscription(subscriber1.address, duration)
        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
      })

      it('emits event on add subscription', async () => {
        await expect(contract.connect(moderator).addSubscription(subscriber1.address, duration))
          .to.emit(contract, 'UpdateSubscription')
          .withArgs(subscriber1.address, duration, expectedDeadline)
      })
    })

    describe('for existing expired subscriber', () => {
      let expectedDeadline = 0

      beforeEach(async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        let currentTimestamp = expirationTimestamp + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        expectedDeadline = currentTimestamp + dayToSeconds(duration)
      })

      it('sets deadline to duration time starting from block time', async () => {
        await contract.connect(moderator).addSubscription(subscriber1.address, duration)
        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
      })

      it('emits event on add subscription', async () => {
        await expect(contract.connect(moderator).addSubscription(subscriber1.address, duration))
          .to.emit(contract, 'UpdateSubscription')
          .withArgs(subscriber1.address, duration, expectedDeadline)
      })
    })
  })

  describe('#subtractSubscription', () => {
    let expectedDeadline = 0
    let duration = 15

    beforeEach(async () => {
      let initialDeadline = await mockSubscriptionDuration(subscriber1, 30)
      expectedDeadline = initialDeadline - dayToSeconds(duration)
    })

    it('reverts if called by non-moderator role', async () => {
      await expect(contract.connect(other).subtractSubscription(subscriber1.address, duration)).to.be.reverted
    })

    it('decreases deadline to provided period amount', async () => {
      await contract.connect(moderator).subtractSubscription(subscriber1.address, duration)
      expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
    })

    it('emits event on subtract subscription', async () => {
      await expect(contract.connect(moderator).subtractSubscription(subscriber1.address, duration))
        .to.emit(contract, 'UpdateSubscription')
        .withArgs(subscriber1.address, -duration, expectedDeadline)
    })
  })

  describe('#setPromoCode', () => {
    let promoCodeName = 'Promo Code'
    let commissionRate = rate(0.025)
    let discountRate = rate(0.015)
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
      let blockTimestamp = (await time.latest()) + 1
      await time.setNextBlockTimestamp(blockTimestamp)
      await contract.connect(moderator).setPromoCode(subscriber1.address, promoCodeName, commissionRate, discountRate, duration)

      let promoCode = await contract.promoCode(promoCodeName)
      expect(promoCode._address).to.eq(subscriber1.address)
      expect(promoCode.commissionRate).to.eq(commissionRate)
      expect(promoCode.discountRate).to.eq(discountRate)
      expect(promoCode.deadline).to.eq(blockTimestamp + dayToSeconds(duration))
    })

    it('emits event on addition', async () => {
      let blockTimestamp = (await time.latest()) + 1
      await time.setNextBlockTimestamp(blockTimestamp)

      await expect(contract.connect(moderator).setPromoCode(subscriber1.address, promoCodeName, commissionRate, discountRate, duration))
        .to.emit(contract, 'PromoCodeAddition')
        .withArgs(subscriber1.address, promoCodeName, commissionRate, discountRate, blockTimestamp + dayToSeconds(duration))
    })
  })

  describe('#claim', () => {
    describe('with balance to claim', () => {
      let promoCodeName = 'Promo Code'
      let commissionRate = rate(0.025)

      beforeEach(async () => {
        await contract.connect(moderator).setPromoCode(promoCodeOwner.address, promoCodeName, commissionRate, rate(0.015), 30)

        await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)
        await contract.connect(subscriber2).subscribeWithPromoCode(duration2, promoCodeName)
      })

      it('sends whole balance to provided withdraw address', async () => {
        await contract.connect(promoCodeOwner).claim(other.address)

        let expectedAmount = rateValue(cost1, commissionRate).add(rateValue(cost2, commissionRate))

        expect(paymentToken.transfer).to.have.been.calledOnceWith(
          other.address,
          convertedAmount(expectedAmount, contractDecimals, paymentTokenDecimals)
        )
      })

      it('resets balance of promoter', async () => {
        await contract.connect(promoCodeOwner).claim(other.address)

        expect(await contract.promoterBalance(promoCodeOwner.address)).to.eq(0)
      })

      it('decreases total balance of promoters', async () => {
        let expectedAmount = await mockPromoterBalance(other, 'Other Promo')

        await contract.connect(promoCodeOwner).claim(other.address)
        expect(await contract.totalPromoterBalance()).to.eq(expectedAmount)
      })
    })

    describe('without balance to claim', () => {
      it('reverts', async () => {
        await expect(contract.connect(promoCodeOwner).claim(other.address)).to.be.revertedWithCustomError(contract, 'NothingToClaim')
      })
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
        convertedAmount(cost1, contractDecimals, paymentTokenDecimals)
      )
    })

    describe('for new subscriber', () => {
      let expectedDeadline = 0

      beforeEach(async () => {
        let currentTimestamp = (await time.latest()) + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        expectedDeadline = currentTimestamp + dayToSeconds(duration1)
      })

      it('sets deadline to duration time starting from block time', async () => {
        await contract.connect(subscriber1).subscribe(duration1)
        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
      })

      it('emits event on subscription', async () => {
        await expect(contract.connect(subscriber1).subscribe(duration1))
          .to.emit(contract, 'Subscription')
          .withArgs(
            subscriber1.address,
            duration1,
            paymentToken.address,
            convertedAmount(cost1, contractDecimals, paymentTokenDecimals),
            expectedDeadline
          )
      })
    })

    describe('for existing non-expired subscriber', () => {
      let expectedDeadline = 0

      beforeEach(async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        await time.setNextBlockTimestamp(expirationTimestamp - 1)

        expectedDeadline = expirationTimestamp + dayToSeconds(duration2)
      })

      it('adds duration to deadline', async () => {
        await contract.connect(subscriber1).subscribe(duration2)
        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
      })

      it('emits event on subscription', async () => {
        await expect(contract.connect(subscriber1).subscribe(duration2))
          .to.emit(contract, 'Subscription')
          .withArgs(
            subscriber1.address,
            duration2,
            paymentToken.address,
            convertedAmount(cost2, contractDecimals, paymentTokenDecimals),
            expectedDeadline
          )
      })
    })

    describe('for existing expired subscriber', () => {
      let expectedDeadline = 0

      beforeEach(async () => {
        let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
        let currentTimestamp = expirationTimestamp + 1
        await time.setNextBlockTimestamp(currentTimestamp)

        expectedDeadline = currentTimestamp + dayToSeconds(duration2)
      })

      it('sets deadline to duration time starting from block time', async () => {
        await contract.connect(subscriber1).subscribe(duration2)
        expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
      })

      it('emits event on subscription', async () => {
        await expect(contract.connect(subscriber1).subscribe(duration2))
          .to.emit(contract, 'Subscription')
          .withArgs(
            subscriber1.address,
            duration2,
            paymentToken.address,
            convertedAmount(cost2, contractDecimals, paymentTokenDecimals),
            expectedDeadline
          )
      })
    })
  })

  describe('#subscribeWithPromoCode', () => {
    let promoCodeName = 'Promo Code'
    let commissionRate = rate(0.025)
    let discountRate = rate(0.015)
    let duration = 90

    describe('with valid promo code', () => {
      beforeEach(async () => {
        await contract.connect(moderator).setPromoCode(promoCodeOwner.address, promoCodeName, commissionRate, discountRate, duration)
      })

      it('reverts if plan does not exist', async () => {
        let invalidDuration = 20
        await expect(contract.connect(subscriber1).subscribeWithPromoCode(invalidDuration, promoCodeName))
          .to.be.revertedWithCustomError(contract, 'InvalidPlan')
          .withArgs(invalidDuration)
      })

      it('transfers payment tokens to contract', async () => {
        await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)

        expect(paymentToken.transferFrom).to.have.been.calledWith(
          subscriber1.address,
          contract.address,
          convertedAmount(cost1.sub(rateValue(cost1, discountRate)), contractDecimals, paymentTokenDecimals)
        )
      })

      it('increases balance of promoter', async () => {
        let commission = rateValue(cost1, commissionRate)
        let commission2 = rateValue(cost2, commissionRate)

        await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)
        expect(await contract.promoterBalance(promoCodeOwner.address)).to.eq(commission)

        await contract.connect(subscriber2).subscribeWithPromoCode(duration2, promoCodeName)
        expect(await contract.promoterBalance(promoCodeOwner.address)).to.eq(commission.add(commission2))
      })

      it('increases total balance of promoters', async () => {
        let otherPromoCodeName = 'Other Promo Code'
        let otherCommissionRate = rate(0.07)

        await contract.connect(moderator).setPromoCode(other.address, otherPromoCodeName, otherCommissionRate, discountRate, duration)

        let commission = rateValue(cost1, commissionRate)
        let commission2 = rateValue(cost2, otherCommissionRate)

        await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)
        expect(await contract.totalPromoterBalance()).to.eq(commission)

        await contract.connect(subscriber2).subscribeWithPromoCode(duration2, otherPromoCodeName)
        expect(await contract.totalPromoterBalance()).to.eq(commission.add(commission2))
      })

      describe('for new subscriber', () => {
        let expectedDeadline = 0

        beforeEach(async () => {
          let currentTimestamp = (await time.latest()) + 1
          await time.setNextBlockTimestamp(currentTimestamp)

          expectedDeadline = currentTimestamp + dayToSeconds(duration1)
        })

        it('sets deadline to duration time starting from block time', async () => {
          await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)
          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
        })

        it('emits event on subscription', async () => {
          await expect(contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName))
            .to.emit(contract, 'SubscriptionWithPromoCode')
            .withArgs(
              subscriber1.address,
              promoCodeName,
              duration1,
              paymentToken.address,
              convertedAmount(cost1.sub(rateValue(cost1, discountRate)), contractDecimals, paymentTokenDecimals),
              expectedDeadline
            )
        })
      })

      describe('for existing non-expired subscriber', () => {
        let expectedDeadline = 0

        beforeEach(async () => {
          let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
          await time.setNextBlockTimestamp(expirationTimestamp - 1)

          expectedDeadline = expirationTimestamp + dayToSeconds(duration2)
        })

        it('adds duration to deadline', async () => {
          await contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCodeName)
          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
        })

        it('emits event on subscription', async () => {
          await expect(contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCodeName))
            .to.emit(contract, 'SubscriptionWithPromoCode')
            .withArgs(
              subscriber1.address,
              promoCodeName,
              duration2,
              paymentToken.address,
              convertedAmount(cost2.sub(rateValue(cost2, discountRate)), contractDecimals, paymentTokenDecimals),
              expectedDeadline
            )
        })
      })

      describe('for existing expired subscriber', () => {
        let expectedDeadline = 0

        beforeEach(async () => {
          let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
          let currentTimestamp = expirationTimestamp + 1
          await time.setNextBlockTimestamp(currentTimestamp)

          expectedDeadline = currentTimestamp + dayToSeconds(duration2)
        })

        it('sets deadline to duration time starting from block time', async () => {
          await contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCodeName)
          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
        })

        it('emits event on subscription', async () => {
          await expect(contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCodeName))
            .to.emit(contract, 'SubscriptionWithPromoCode')
            .withArgs(
              subscriber1.address,
              promoCodeName,
              duration2,
              paymentToken.address,
              convertedAmount(cost2.sub(rateValue(cost2, discountRate)), contractDecimals, paymentTokenDecimals),
              expectedDeadline
            )
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
    await contract.connect(moderator).addSubscription(signer.address, duration)

    return subscriptionTimestamp + dayToSeconds(duration)
  }

  async function mockPromoterBalance(wallet: Wallet, promoCodeName: string) {
    let commissionRate = rate(0.025)

    await contract.connect(moderator).setPromoCode(wallet.address, promoCodeName, commissionRate, rate(0.1), 30)
    await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCodeName)

    return rateValue(cost1, commissionRate)
  }

  function contractValue(value: number) {
    return BigNumber.from(value * 10 ** contractDecimals)
  }

  function rate(value: number) {
    return BigNumber.from(value * rateMultiplier)
  }

  function rateValue(value: BigNumber, rate: BigNumber) {
    return value.mul(rate).div(rateMultiplier)
  }
})
