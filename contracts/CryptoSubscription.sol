// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract CryptoSubscription is AccessControl {
    event PaymentTokenChange(address indexed oldAddress, address indexed newAddress, address withdrawAddress, uint indexed withdrawAmount);
    event Whitelist(address indexed _address, uint16 duration);
    event Subscription(address indexed subscriber, uint16 duration, uint32 cost);

    error InvalidPlan(uint16 duration);

    bytes32 public constant MODERATOR_ROLE = keccak256("MODERATOR_ROLE");
    uint32 private constant ONE_DAY_SECONDS = 24 * 60 * 60;

    IERC20Metadata private _paymentToken;
    uint16 public commissionRate;
    uint16 public discountRate;

    mapping(uint16 => uint16) private _plans;
    mapping(address => uint32) private _subscribers;

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

    // Public View Methods

    function paymentToken() public view returns (address) {
        return address(_paymentToken);
    }

    function planCost(uint16 duration) public view returns (uint16) {
        return _plans[duration];
    }

    function subscriptionDeadline(address _address) public view returns (uint32) {
        return _subscribers[_address];
    }

    // Admin Actions

    function changePaymentToken(address _address, address withdrawAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAddress = address(_paymentToken);
        uint balance = _paymentToken.balanceOf(address(this));

        _paymentToken.transfer(withdrawAddress, balance);
        _paymentToken = IERC20Metadata(_address);

        emit PaymentTokenChange(oldAddress, _address, withdrawAddress, balance);
    }

    // Moderator Actions

    function updateCommissionRate(uint16 newRate) public onlyRole(MODERATOR_ROLE) {
        commissionRate = newRate;
    }

    function updateDiscountRate(uint16 newRate) public onlyRole(MODERATOR_ROLE) {
        discountRate = newRate;
    }

    function updatePlans(uint16[] calldata durations, uint16[] calldata costs) public onlyRole(MODERATOR_ROLE) {
        uint length = durations.length;
        for (uint i = 0; i < length; i++) {
            _plans[durations[i]] = costs[i];
        }
    }

    function whitelist(address _address, uint16 duration) public onlyRole(MODERATOR_ROLE) {
        uint32 currentDeadline = _subscribers[_address];

        if (currentDeadline == 0 || block.timestamp > currentDeadline) {
            _subscribers[_address] = uint32(block.timestamp) + uint32(duration) * ONE_DAY_SECONDS;
        } else {
            _subscribers[_address] = currentDeadline + uint32(duration) * ONE_DAY_SECONDS;
        }

        emit Whitelist(_address, duration);
    }

    // Subscriber Actions

    function subscribe(uint16 duration) public {
        uint16 cost = _plans[duration];

        if (cost == 0) revert InvalidPlan(duration);

        _paymentToken.transferFrom(msg.sender, address(this), cost * 10 ** _paymentToken.decimals());

        uint32 currentDeadline = _subscribers[msg.sender];

        if (currentDeadline == 0 || block.timestamp > currentDeadline) {
            _subscribers[msg.sender] = uint32(block.timestamp) + uint32(duration) * ONE_DAY_SECONDS;
        } else {
            _subscribers[msg.sender] = currentDeadline + uint32(duration) * ONE_DAY_SECONDS;
        }

        emit Subscription(msg.sender, duration, cost);
    }

}
