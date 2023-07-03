// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract CryptoSubscription is AccessControl {
    struct PromoCode {
        address _address;
        uint commissionRate;
        uint discountRate;
        uint deadline;
    }

    event PaymentTokenChange(address indexed oldAddress, address indexed newAddress);
    event UpdateSubscription(address indexed _address, int duration, uint deadline);
    event PromoCodeAddition(address indexed _address, string name, uint commissionRate, uint discountRate, uint deadline);
    event Subscription(address indexed subscriber, uint duration, address paymentToken, uint tokenCost, uint deadline);
    event SubscriptionWithPromoCode(address indexed subscriber, string indexed promoCode, uint duration, address paymentToken, uint tokenCost, uint deadline);

    error InvalidPlan(uint duration);
    error EmptyPromoCode();
    error PromoCodeAlreadyExists(string promoCode);
    error InvalidPromoCode(string promoCode);
    error ExpiredPromoCode(string promoCode);
    error ZeroDuration();
    error NothingToClaim();

    bytes32 public constant MODERATOR_ROLE = keccak256("MODERATOR_ROLE");
    uint private constant ONE_DAY_SECONDS = 24 * 60 * 60;
    uint private constant RATE_MULTIPLIER = 1000;
    uint8 private constant DECIMALS = 2;

    IERC20Metadata private _paymentToken;

    mapping(uint => uint) private _plans; // duration => cost
    mapping(address => uint) private _subscriptions; // subscriber => deadline

    uint public totalPromoterBalance;
    mapping(address => uint) private _promoterBalances;

    mapping(string => PromoCode) private _promoCodes; // name => promo code

    constructor(address paymentTokenAddress, uint[] memory planDurations, uint[] memory planCosts) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _paymentToken = IERC20Metadata(paymentTokenAddress);

        _paymentToken.balanceOf(address(this));

        uint length = planDurations.length;
        for (uint i = 0; i < length; i++) {
            uint duration = planDurations[i];
            _plans[duration] = planCosts[i];
        }
    }

    // Public View Methods

    function paymentToken() public view returns (address) {
        return address(_paymentToken);
    }

    function planCost(uint duration) public view returns (uint) {
        return _plans[duration];
    }

    function subscriptionDeadline(address _address) public view returns (uint) {
        return _subscriptions[_address];
    }

    function promoterBalance(address _address) public view returns (uint) {
        return _promoterBalances[_address];
    }

    function promoCode(string memory name) public view returns (PromoCode memory) {
        return _promoCodes[name];
    }

    function addressInfo(address _address) public view returns (bool, bool, uint, uint) {
        return (hasRole(MODERATOR_ROLE, _address), hasRole(DEFAULT_ADMIN_ROLE, _address), _subscriptions[_address], _promoterBalances[_address]);
    }

    // Admin Actions

    function changePaymentToken(address _address, address withdrawAddress, address chargeAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAddress = address(_paymentToken);
        uint _balance = _paymentToken.balanceOf(address(this));

        if (_balance != 0) {
            _paymentToken.transfer(withdrawAddress, _balance);
        }

        _paymentToken = IERC20Metadata(_address);
        _paymentToken.balanceOf(address(this));

        uint _totalPromoterBalance = totalPromoterBalance;

        if (_totalPromoterBalance != 0) {
            _paymentToken.transferFrom(chargeAddress, address(this), _convert(_totalPromoterBalance, DECIMALS, _paymentToken.decimals()));
        }

        emit PaymentTokenChange(oldAddress, _address);
    }

    function withdraw(address _address) public onlyRole(DEFAULT_ADMIN_ROLE) {
        uint promotersBalance = _convert(totalPromoterBalance, DECIMALS, _paymentToken.decimals());
        uint contractBalance = _paymentToken.balanceOf(address(this));

        _paymentToken.transfer(_address, contractBalance - promotersBalance);
    }

    // Moderator Actions

    function updatePlans(uint[] calldata durations, uint[] calldata costs) public onlyRole(MODERATOR_ROLE) {
        uint length = durations.length;
        for (uint i = 0; i < length; i++) {
            uint duration = durations[i];
            if (duration == 0) revert ZeroDuration();
            _plans[duration] = costs[i];
        }
    }

    function addSubscription(address _address, uint duration) public onlyRole(MODERATOR_ROLE) {
        uint deadline = _updateDeadline(_address, duration);
        emit UpdateSubscription(_address, int(duration), deadline);
    }

    function subtractSubscription(address _address, uint duration) public onlyRole(MODERATOR_ROLE) {
        uint newDeadline = _subscriptions[_address] - duration * ONE_DAY_SECONDS;
        _subscriptions[_address] = newDeadline;
        emit UpdateSubscription(_address, - int(duration), newDeadline);
    }

    function setPromoCode(address _address, string memory name, uint commissionRate, uint discountRate, uint duration) public onlyRole(MODERATOR_ROLE) {
        if (bytes(name).length == 0) revert EmptyPromoCode();
        if (_promoCodes[name]._address != address(0)) revert PromoCodeAlreadyExists(name);

        uint deadline = block.timestamp + duration * ONE_DAY_SECONDS;

        PromoCode storage _promoCode = _promoCodes[name];
        _promoCode._address = _address;
        _promoCode.commissionRate = commissionRate;
        _promoCode.discountRate = discountRate;
        _promoCode.deadline = deadline;

        emit PromoCodeAddition(_address, name, commissionRate, discountRate, deadline);
    }

    // Promoter Actions

    function claim(address withdrawAddress) public {
        uint _balance = _promoterBalances[msg.sender];

        if (_balance == 0) revert NothingToClaim();

        _paymentToken.transfer(withdrawAddress, _convert(_balance, DECIMALS, _paymentToken.decimals()));
        _promoterBalances[msg.sender] = 0;
        totalPromoterBalance -= _balance;
    }

    // Subscriber Actions

    function subscribe(uint duration) public {
        uint cost = _plans[duration];

        if (cost == 0) revert InvalidPlan(duration);

        uint tokenCost = _convert(cost, DECIMALS, _paymentToken.decimals());

        _paymentToken.transferFrom(msg.sender, address(this), tokenCost);
        uint deadline = _updateDeadline(msg.sender, duration);

        emit Subscription(msg.sender, duration, address(_paymentToken), tokenCost, deadline);
    }

    function subscribeWithPromoCode(uint duration, string memory promoCodeName) public {
        uint cost = _plans[duration];

        if (cost == 0) revert InvalidPlan(duration);

        PromoCode memory _promoCode = _promoCodes[promoCodeName];

        if (_promoCode._address == address(0)) revert InvalidPromoCode(promoCodeName);
        if (_promoCode.deadline < block.timestamp) revert ExpiredPromoCode(promoCodeName);

        uint promoCodeAmount = cost * _promoCode.commissionRate / RATE_MULTIPLIER;
        _promoterBalances[_promoCode._address] += promoCodeAmount;
        totalPromoterBalance += promoCodeAmount;

        uint contractAmount = cost - cost * _promoCode.discountRate / RATE_MULTIPLIER;
        uint tokenContractAmount = _convert(contractAmount, DECIMALS, _paymentToken.decimals());

        _paymentToken.transferFrom(msg.sender, address(this), tokenContractAmount);
        uint deadline = _updateDeadline(msg.sender, duration);

        emit SubscriptionWithPromoCode(msg.sender, promoCodeName, duration, address(_paymentToken), tokenContractAmount, deadline);
    }

    // Private Methods

    function _updateDeadline(address _address, uint duration) private returns (uint) {
        uint currentDeadline = _subscriptions[_address];
        uint newDeadline;

        if (currentDeadline == 0 || block.timestamp > currentDeadline) {
            newDeadline = block.timestamp + duration * ONE_DAY_SECONDS;
        } else {
            newDeadline = currentDeadline + duration * ONE_DAY_SECONDS;
        }

        _subscriptions[_address] = newDeadline;

        return newDeadline;
    }

    function _convert(uint amount, uint8 fromDecimals, uint8 toDecimals) private pure returns (uint) {
        if (fromDecimals > toDecimals) {
            return amount / 10 ** (fromDecimals - toDecimals);
        } else if (fromDecimals < toDecimals) {
            return amount * 10 ** (toDecimals - fromDecimals);
        } else {
            return amount;
        }
    }

}
