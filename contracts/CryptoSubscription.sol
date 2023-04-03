// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract CryptoSubscription is AccessControl {
    struct Plan {
        uint8 index;
        uint16 cost;
    }

    event PaymentTokenChange(address indexed oldAddress, address indexed newAddress, address withdrawAddress, uint indexed withdrawAmount);
    event Whitelist(address indexed _address, uint16 duration);
    event PromoCodeAddition(address indexed owner, string promoCode);
    event Subscription(address indexed subscriber, uint16 duration, uint32 cost);
    event SubscriptionWithPromoCode(address indexed subscriber, string promoCode, uint16 duration, uint32 cost);

    error InvalidPlan(uint16 duration);
    error EmptyPromoCode();
    error PromoCodeAlreadyExists(string promoCode);
    error SubscriptionRequired();
    error InvalidPromoCode(string promoCode);
    error ZeroDuration();

    bytes32 public constant MODERATOR_ROLE = keccak256("MODERATOR_ROLE");
    uint32 private constant ONE_DAY_SECONDS = 24 * 60 * 60;

    IERC20Metadata private _paymentToken;
    uint16 public commissionRate;
    uint16 public discountRate;

    uint16[] private _planIndex;
    mapping(uint16 => Plan) private _plans; // duration => cost

    mapping(address => uint32) private _subscriptions; // subscriber => deadline
    mapping(string => address) private _promoCodes; // promo code => owner

    constructor(address paymentTokenAddress, uint16 _commissionRate, uint16 _discountRate, uint16[] memory planDurations, uint16[] memory planCosts) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _paymentToken = IERC20Metadata(paymentTokenAddress);
        commissionRate = _commissionRate;
        discountRate = _discountRate;

        uint length = planDurations.length;
        for (uint i = 0; i < length; i++) {
            uint16 duration = planDurations[i];

            Plan storage plan = _plans[duration];
            plan.index = uint8(i);
            plan.cost = planCosts[i];

            _planIndex.push(duration);
        }
    }

    // Modifiers

    modifier activeSubscriber(address _address) {
        uint32 currentDeadline = _subscriptions[_address];
        if (currentDeadline == 0 || block.timestamp > currentDeadline) revert SubscriptionRequired();
        _;
    }

    // Public View Methods

    function paymentToken() public view returns (address) {
        return address(_paymentToken);
    }

    function plans() public view returns (uint16[] memory, uint16[] memory) {
        uint length = _planIndex.length;

        uint16[] memory durations = new uint16[](length);
        uint16[] memory costs = new uint16[](length);

        for (uint i = 0; i < length; i++) {
            uint16 duration = _planIndex[i];
            durations[i] = duration;
            costs[i] = _plans[duration].cost;
        }

        return (durations, costs);
    }

    function subscriptionDeadline(address _address) public view returns (uint32) {
        return _subscriptions[_address];
    }

    function promoCodeOwner(string memory promoCode) public view returns (address) {
        return _promoCodes[promoCode];
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
            uint16 duration = durations[i];
            uint16 cost = costs[i];
            Plan storage plan = _plans[duration];

            if (duration == 0) revert ZeroDuration();

            if (cost == 0) {
                uint8 indexToDelete = plan.index;
                uint16 durationToMove = _planIndex[_planIndex.length - 1];
                _planIndex[indexToDelete] = durationToMove;
                _plans[durationToMove].index = indexToDelete;
                _planIndex.pop();

                plan.index = 0;
                plan.cost = 0;
            } else if (plan.cost == 0) {
                plan.index = uint8(_planIndex.length);
                plan.cost = cost;
                _planIndex.push(duration);
            } else {
                plan.cost = cost;
            }
        }
    }

    function whitelist(address _address, uint16 duration) public onlyRole(MODERATOR_ROLE) {
        _updateDeadline(_address, duration);
        emit Whitelist(_address, duration);
    }

    // Promoter Actions

    function addPromoCode(string memory promoCode) public activeSubscriber(msg.sender) {
        if (bytes(promoCode).length == 0) revert EmptyPromoCode();
        if (_promoCodes[promoCode] != address(0)) revert PromoCodeAlreadyExists(promoCode);

        _promoCodes[promoCode] = msg.sender;

        emit PromoCodeAddition(msg.sender, promoCode);
    }

    // Subscriber Actions

    function subscribe(uint16 duration) public {
        uint16 cost = _plans[duration].cost;

        if (cost == 0) revert InvalidPlan(duration);

        _paymentToken.transferFrom(msg.sender, address(this), cost * 10 ** _paymentToken.decimals());
        _updateDeadline(msg.sender, duration);

        emit Subscription(msg.sender, duration, cost);
    }

    function subscribeWithPromoCode(uint16 duration, string memory promoCode) public {
        uint16 cost = _plans[duration].cost;
        address codeOwner = _promoCodes[promoCode];

        if (cost == 0) revert InvalidPlan(duration);
        if (codeOwner == address(0)) revert InvalidPromoCode(promoCode);

        uint tokenCost = cost * 10 ** _paymentToken.decimals();
        uint promoCodeOwnerAmount = tokenCost * commissionRate / 1000;
        uint contractAmount = tokenCost - tokenCost * (commissionRate + discountRate) / 1000;

        _paymentToken.transferFrom(msg.sender, codeOwner, promoCodeOwnerAmount);
        _paymentToken.transferFrom(msg.sender, address(this), contractAmount);

        _updateDeadline(msg.sender, duration);

        emit SubscriptionWithPromoCode(msg.sender, promoCode, duration, cost);
    }

    // Private Methods

    function _updateDeadline(address _address, uint16 duration) private {
        uint32 currentDeadline = _subscriptions[_address];

        if (currentDeadline == 0 || block.timestamp > currentDeadline) {
            _subscriptions[_address] = uint32(block.timestamp) + uint32(duration) * ONE_DAY_SECONDS;
        } else {
            _subscriptions[_address] = currentDeadline + uint32(duration) * ONE_DAY_SECONDS;
        }
    }

}
