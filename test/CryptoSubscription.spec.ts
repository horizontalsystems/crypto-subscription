import { expect, use } from 'chai'
import { ethers } from 'hardhat'
import { smock } from '@defi-wonderland/smock'
import { Wallet } from 'ethers'
import { CryptoSubscription } from '../typechain-types'

use(smock.matchers)

describe('CryptoSubscription', function () {
  let contract: CryptoSubscription

  let owner: Wallet
  let moderator: Wallet
  let other: Wallet

  beforeEach(async () => {
    ;[owner, moderator, other] = await (ethers as any).getSigners()

    const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription', { signer: owner })
    contract = await CryptoSubscription.deploy()
  })

  describe('#constructor', () => {
    it('tests something', async () => {
      expect(await contract.zeroAddress()).to.eq('0x0000000000000000000000000000000000000000')
    })
  })
})
