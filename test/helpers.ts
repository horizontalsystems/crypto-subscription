import { BigNumber } from 'ethers'

export function dayToSeconds(days: number) {
  return days * 24 * 60 * 60
}

export function toTokenAmount(amount: number, decimals: number) {
  return BigNumber.from(amount).mul(BigNumber.from(10).pow(decimals))
}

export function convertedAmount(amount: BigNumber, fromDecimals: number, toDecimals: number) {
  if (fromDecimals > toDecimals) {
    return amount.div(BigNumber.from(10).pow(fromDecimals - toDecimals))
  } else if (fromDecimals < toDecimals) {
    return amount.mul(BigNumber.from(10).pow(toDecimals - fromDecimals))
  } else {
    return amount
  }
}
