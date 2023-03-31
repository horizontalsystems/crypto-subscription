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

  let commissionRate = 0.025
  let discountRate = 0.015

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
    contract = await CryptoSubscription.deploy(
      paymentToken.address,
      commissionRate * rateMultiplier,
      discountRate * rateMultiplier,
      durations,
      costs
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

    describe('set initial plan costs', () => {
      for (let i in durations) {
        it(`sets ${durations[i]}-day plan cost to provided value ${costs[i]}`, async () => {
          expect(await contract.planCost(durations[i])).to.eq(costs[i])
        })
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
          .to.emit(contract, 'PaymentTokenChange')
          .withArgs(paymentToken.address, otherPaymentToken.address, other.address, amount)
      })
    })

    describe('#updateCommissionRate', () => {
      let newRate = 0.045
      let newContractRate = newRate * rateMultiplier

      it('reverts if called by non-moderator role', async () => {
        await expect(contract.connect(other).updateCommissionRate(newContractRate)).to.be.reverted
      })

      it('changes commission rate', async () => {
        await contract.connect(moderator).updateCommissionRate(newContractRate)
        expect(await contract.commissionRate()).to.eq(newContractRate)
      })
    })

    describe('#updateDiscountRate', () => {
      let newRate = 0.035
      let newContractRate = newRate * rateMultiplier

      it('reverts if called by non-moderator role', async () => {
        await expect(contract.connect(other).updateDiscountRate(newContractRate)).to.be.reverted
      })

      it('changes discount rate', async () => {
        await contract.connect(moderator).updateDiscountRate(newContractRate)
        expect(await contract.discountRate()).to.eq(newContractRate)
      })
    })

    describe('#updatePlans', () => {
      let updatedDurations = [duration1, duration2, 60]
      let updatedCosts = [400, 0, 700]
      let expectedDurations = [duration1, duration2, duration3, 60]
      let expectedCosts = [400, 0, cost3, 700]

      it('reverts if called by non-moderator role', async () => {
        await expect(contract.connect(other).updatePlans(updatedDurations, updatedCosts)).to.be.reverted
      })

      describe('merges current plans with provided ones', () => {
        beforeEach(async () => {
          await contract.connect(moderator).updatePlans(updatedDurations, updatedCosts)
        })

        for (let i in expectedDurations) {
          it(`results in ${expectedDurations[i]}-day plan cost equals ${expectedCosts[i]}`, async () => {
            expect(await contract.planCost(expectedDurations[i])).to.eq(expectedCosts[i])
          })
        }
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

    describe('#addPromoCode', () => {
      let promoCode = 'Promo Code'

      describe('for active subscriber', () => {
        beforeEach(async () => {
          await mockSubscriptionDuration(subscriber1, 30)
        })

        it('reverts if promo code is empty', async () => {
          await expect(contract.connect(subscriber1).addPromoCode('')).to.be.revertedWithCustomError(contract, 'EmptyPromoCode')
        })

        it('reverts if promo code does already exist', async () => {
          await contract.connect(subscriber1).addPromoCode(promoCode)

          await expect(contract.connect(subscriber1).addPromoCode(promoCode))
            .to.be.revertedWithCustomError(contract, 'PromoCodeAlreadyExists')
            .withArgs(promoCode)
        })

        it('adds promo code referencing caller address', async () => {
          await contract.connect(subscriber1).addPromoCode(promoCode)

          expect(await contract.promoCodeOwner(promoCode)).to.eq(subscriber1.address)
        })

        it('emits event on addition', async () => {
          await expect(contract.connect(subscriber1).addPromoCode(promoCode))
            .to.emit(contract, 'PromoCodeAddition')
            .withArgs(subscriber1.address, promoCode)
        })
      })

      describe('for inactive subscriber', () => {
        it('reverts if caller has no active subscription', async () => {
          await expect(contract.connect(subscriber1).addPromoCode(promoCode)).to.be.revertedWithCustomError(
            contract,
            'SubscriptionRequired'
          )
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

    describe('#subscribeWithPromoCode', () => {
      describe('with valid promo code', () => {
        let promoCode = 'Promo Code'

        beforeEach(async () => {
          await mockSubscriptionDuration(promoCodeOwner, 30)
          await contract.connect(promoCodeOwner).addPromoCode(promoCode)
        })

        it('reverts if plan does not exist', async () => {
          let invalidDuration = 20
          await expect(contract.connect(subscriber1).subscribeWithPromoCode(invalidDuration, promoCode))
            .to.be.revertedWithCustomError(contract, 'InvalidPlan')
            .withArgs(invalidDuration)
        })

        it('transfers payment tokens to contract and promo code owner', async () => {
          await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCode)

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
          await expect(contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCode))
            .to.emit(contract, 'SubscriptionWithPromoCode')
            .withArgs(subscriber1.address, promoCode, duration1, cost1)
        })

        describe('for new subscriber', () => {
          it('sets deadline to duration time starting from block time', async () => {
            let currentTimestamp = (await time.latest()) + 1
            await time.setNextBlockTimestamp(currentTimestamp)

            await contract.connect(subscriber1).subscribeWithPromoCode(duration1, promoCode)

            expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration1))
          })
        })

        describe('for existing non-expired subscriber', () => {
          it('adds duration to deadline', async () => {
            let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
            await time.setNextBlockTimestamp(expirationTimestamp - 1)

            await contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCode)

            expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expirationTimestamp + dayToSeconds(duration2))
          })
        })

        describe('for existing expired subscriber', () => {
          it('sets deadline to duration time starting from block time', async () => {
            let expirationTimestamp = await mockSubscriptionDuration(subscriber1, duration1)
            let currentTimestamp = expirationTimestamp + 1
            await time.setNextBlockTimestamp(currentTimestamp)

            await contract.connect(subscriber1).subscribeWithPromoCode(duration2, promoCode)

            expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(currentTimestamp + dayToSeconds(duration2))
          })
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
  })

  async function mockSubscriptionDuration(signer: Wallet, duration: number) {
    let subscriptionTimestamp = (await time.latest()) + 1

    await time.setNextBlockTimestamp(subscriptionTimestamp)
    await contract.connect(moderator).whitelist(signer.address, duration)

    return subscriptionTimestamp + dayToSeconds(duration)
  }
})
