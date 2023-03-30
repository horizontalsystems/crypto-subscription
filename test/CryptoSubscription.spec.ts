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
  let other: Wallet

  beforeEach(async () => {
    ;[owner, moderator, subscriber1, subscriber2, other] = await (ethers as any).getSigners()

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

      it('reverts if called by non-default admin role', async () => {
        await expect(contract.connect(moderator).updateCommissionRate(newContractRate)).to.be.reverted
      })

      it('changes commission rate', async () => {
        await contract.connect(owner).updateCommissionRate(newContractRate)
        expect(await contract.commissionRate()).to.eq(newContractRate)
      })
    })

    describe('#updateDiscountRate', () => {
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

    describe('#updatePlans', () => {
      let updatedDurations = [duration1, duration2, 60]
      let updatedCosts = [400, 0, 700]
      let expectedDurations = [duration1, duration2, duration3, 60]
      let expectedCosts = [400, 0, cost3, 700]

      it('reverts if called by non-default admin role', async () => {
        await expect(contract.connect(moderator).updatePlans(updatedDurations, updatedCosts)).to.be.reverted
      })

      describe('merges current plans with provided ones', () => {
        beforeEach(async () => {
          await contract.connect(owner).updatePlans(updatedDurations, updatedCosts)
        })

        for (let i in expectedDurations) {
          it(`results in ${expectedDurations[i]}-day plan cost equals ${expectedCosts[i]}`, async () => {
            expect(await contract.planCost(expectedDurations[i])).to.eq(expectedCosts[i])
          })
        }
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

      describe('new subscriber', () => {
        it('sets deadline to duration time starting from block time', async () => {
          let blockTimestamp = (await time.latest()) + 1

          await time.setNextBlockTimestamp(blockTimestamp)
          await contract.connect(subscriber1).subscribe(duration1)

          let expectedDeadline = blockTimestamp + dayToSeconds(duration1)

          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
        })
      })

      describe('existing non-expired subscriber', () => {
        let initialSubscriptionTimestamp: number
        let subscriptionTimestamp: number

        beforeEach(async () => {
          initialSubscriptionTimestamp = (await time.latest()) + 1
          subscriptionTimestamp = initialSubscriptionTimestamp + dayToSeconds(duration1) - 1

          await time.setNextBlockTimestamp(initialSubscriptionTimestamp)
          await contract.connect(subscriber1).subscribe(duration1)
        })

        it('adds duration to deadline', async () => {
          await time.setNextBlockTimestamp(subscriptionTimestamp)
          await contract.connect(subscriber1).subscribe(duration2)

          let expectedDeadline = initialSubscriptionTimestamp + dayToSeconds(duration1 + duration2)

          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
        })
      })

      describe('existing expired subscriber', () => {
        let initialSubscriptionTimestamp: number
        let subscriptionTimestamp: number

        beforeEach(async () => {
          initialSubscriptionTimestamp = (await time.latest()) + 1
          subscriptionTimestamp = initialSubscriptionTimestamp + dayToSeconds(duration1) + 1

          await time.setNextBlockTimestamp(initialSubscriptionTimestamp)
          await contract.connect(subscriber1).subscribe(duration1)
        })

        it('sets deadline to duration time starting from block time', async () => {
          await time.setNextBlockTimestamp(subscriptionTimestamp)
          await contract.connect(subscriber1).subscribe(duration2)

          let expectedDeadline = subscriptionTimestamp + dayToSeconds(duration2)

          expect(await contract.subscriptionDeadline(subscriber1.address)).to.eq(expectedDeadline)
        })
      })
    })
  })
})
