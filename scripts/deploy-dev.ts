import { ethers } from 'hardhat'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deployer address:', deployer.address)

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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
