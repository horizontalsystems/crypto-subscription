import { expect, use } from 'chai'
import { ethers } from 'hardhat'
import { FakeContract, smock } from '@defi-wonderland/smock'
import { Wallet } from 'ethers'
import { CryptoSubscription, IERC20Metadata } from '../typechain-types'

use(smock.matchers)

describe('CryptoSubscription', function () {
  let contract: CryptoSubscription
  let token: FakeContract<IERC20Metadata>
  let decimals = 6

  let rateMultiplier = 1000

  let commissionRate = 0.025
  let discountRate = 0.015

  let plans: { [key: number]: number } = { 30: 200, 90: 500, 180: 800 }

  let owner: Wallet
  let moderator: Wallet
  let other: Wallet

  beforeEach(async () => {
    ;[owner, moderator, other] = await (ethers as any).getSigners()

    token = await smock.fake('IERC20Metadata')
    token.decimals.whenCalledWith().returns(decimals)

    const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription', { signer: owner })
    contract = await CryptoSubscription.deploy(
      token.address,
      commissionRate * rateMultiplier,
      discountRate * rateMultiplier,
      Object.keys(plans),
      Object.values(plans)
    )
  })

  describe('#constructor', () => {
    it('grants owner default admin role', async () => {
      let defaultAdminRole = await contract.DEFAULT_ADMIN_ROLE()
      expect(await contract.hasRole(defaultAdminRole, owner.address)).to.be.true
    })

    it('sets token to provided one', async () => {
      expect(await contract.tokenAddress()).to.eq(token.address)
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
})
