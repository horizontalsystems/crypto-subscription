import { ethers } from 'hardhat'

async function main() {
  const [deployer] = await ethers.getSigners()

  const tokenAddress = process.env.TOKEN_ADDRESS
  const commissionRate = 0.2
  const discountRate = 0.1
  const plans = { 30: 200, 90: 500, 180: 800 }

  if (tokenAddress === undefined) {
    throw new Error('Token address is required')
  }

  console.log('Deploying contract with the account:', deployer.address)
  console.log('Account balance:', (await deployer.getBalance()).toString())

  const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription')
  const contract = await CryptoSubscription.deploy(
    tokenAddress,
    commissionRate * 1000,
    discountRate * 1000,
    Object.keys(plans),
    Object.values(plans)
  )
  await contract.deployed()

  console.log('CryptoSubscription contract address:', contract.address)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
