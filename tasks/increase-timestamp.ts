import { task } from 'hardhat/config'

task('increase-timestamp', '')
  .addPositionalParam('days')
  .setAction(async ({ days }, { ethers }) => {
    const seconds = days * 24 * 60 * 60

    const blockNumBefore = await ethers.provider.getBlockNumber()
    const blockBefore = await ethers.provider.getBlock(blockNumBefore)
    const timestampBefore = blockBefore.timestamp

    console.log('Timestamp Before:', new Date(timestampBefore * 1000).toLocaleString('en-US'))

    await ethers.provider.send('evm_increaseTime', [seconds])
    await ethers.provider.send('evm_mine', [])

    const blockNumAfter = await ethers.provider.getBlockNumber()
    const blockAfter = await ethers.provider.getBlock(blockNumAfter)
    const timestampAfter = blockAfter.timestamp

    console.log('Timestamp After:', new Date(timestampAfter * 1000).toLocaleString('en-US'))
  })
