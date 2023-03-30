// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract CryptoSubscription is AccessControl {
    event PaymentTokenChanged(address indexed _oldAddress, address indexed _newAddress, address withdrawAddress, uint indexed withdrawAmount);

    bytes32 public constant MODERATOR_ROLE = keccak256("MODERATOR_ROLE");

    IERC20Metadata private _paymentToken;
    uint16 public commissionRate;
    uint16 public discountRate;

    mapping(uint16 => uint16) private _plans;

    constructor(address paymentTokenAddress, uint16 _commissionRate, uint16 _discountRate, uint16[] memory planDurations, uint16[] memory planCosts) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _paymentToken = IERC20Metadata(paymentTokenAddress);
        commissionRate = _commissionRate;
        discountRate = _discountRate;

        uint planLength = planDurations.length;
        for (uint i = 0; i < planLength; i++) {
            _plans[planDurations[i]] = planCosts[i];
        }
    }

    function paymentToken() public view returns (address) {
        return address(_paymentToken);
    }

    function planCost(uint16 duration) public view returns (uint16) {
        return _plans[duration];
    }

    function changePaymentToken(address _address, address withdrawAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAddress = address(_paymentToken);
        uint balance = _paymentToken.balanceOf(address(this));

        _paymentToken.transfer(withdrawAddress, balance);
        _paymentToken = IERC20Metadata(_address);

        emit PaymentTokenChanged(oldAddress, _address, withdrawAddress, balance);
    }

    function updateCommissionRate(uint16 newRate) public onlyRole(DEFAULT_ADMIN_ROLE) {
        commissionRate = newRate;
    }

    function updateDiscountRate(uint16 newRate) public onlyRole(DEFAULT_ADMIN_ROLE) {
        discountRate = newRate;
    }

    function updatePlans(uint16[] calldata durations, uint16[] calldata costs) public onlyRole(DEFAULT_ADMIN_ROLE) {
        uint length = durations.length;
        for (uint i = 0; i < length; i++) {
            _plans[durations[i]] = costs[i];
        }
    }

}
