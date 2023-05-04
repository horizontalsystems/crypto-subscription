import { ethers } from 'hardhat'

async function main() {
  const [deployer, moderator, promoter] = await ethers.getSigners()

  console.log('Deployer address:', deployer.address)
  console.log('Moderator address:', moderator.address)
  console.log('Promoter address:', promoter.address)

  const tokenDecimals = 6
  const plans = { 30: 200, 90: 500, 180: 800 }

  const Token = await ethers.getContractFactory('TestErc20')
  const token = await Token.deploy(tokenDecimals)
  await token.deployed()

  console.log('Token address:', token.address)

  const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription')
  const contract = await CryptoSubscription.deploy(
    token.address,
    Object.keys(plans),
    Object.values(plans)
  )
  await contract.deployed()

  console.log('CryptoSubscription contract address:', contract.address)

  await contract.connect(deployer).grantRole(await contract.MODERATOR_ROLE(), moderator.address)

  const promoCodeName = 'Unstoppable'
  const commissionRate = 0.2
  const discountRate = 0.1
  const duration = 30
  await contract.connect(moderator).setPromoCode(promoter.address, promoCodeName, commissionRate * 1000, discountRate * 1000, duration)

  console.log('Promo code created:', promoCodeName)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
