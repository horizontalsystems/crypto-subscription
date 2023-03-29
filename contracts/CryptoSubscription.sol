// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract CryptoSubscription is AccessControl {
    IERC20Metadata private _token;
    uint16 public commissionRate;
    uint16 public discountRate;

    mapping(uint16 => uint16) private _plans;

    constructor(address _tokenAddress, uint16 _commissionRate, uint16 _discountRate, uint16[] memory _planDurations, uint16[] memory _planCosts) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _token = IERC20Metadata(_tokenAddress);
        commissionRate = _commissionRate;
        discountRate = _discountRate;

        uint planLength = _planDurations.length;
        for (uint i = 0; i < planLength; i++) {
            _plans[_planDurations[i]] = _planCosts[i];
        }
    }

    function tokenAddress() public view returns (address) {
        return address(_token);
    }

    function planCost(uint16 duration) public view returns (uint16) {
        return _plans[duration];
    }

}
