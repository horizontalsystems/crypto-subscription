import { ethers } from 'hardhat'

async function main() {
  const [deployer] = await ethers.getSigners()

  const tokenAddress = process.env.TOKEN_ADDRESS
  const contractDecimals = 2
  const plans = {
    30: 200 * 10 ** contractDecimals,
    90: 500 * 10 ** contractDecimals,
    180: 800 * 10 ** contractDecimals
  }

  if (tokenAddress === undefined) {
    throw new Error('Token address is required')
  }

  console.log('Deploying contract with the account:', deployer.address)
  console.log('Account balance:', (await deployer.getBalance()).toString())

  const CryptoSubscription = await ethers.getContractFactory('CryptoSubscription')
  const contract = await CryptoSubscription.deploy(
    tokenAddress,
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
