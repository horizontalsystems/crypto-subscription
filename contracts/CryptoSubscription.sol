// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract CryptoSubscription is AccessControl {
    struct Plan {
        uint8 index;
        uint16 cost;
    }

    struct PromoCode {
        address _address;
        uint16 commissionRate;
        uint16 discountRate;
        uint32 deadline;
    }

    event PaymentTokenChange(address indexed oldAddress, address indexed newAddress, address withdrawAddress, uint indexed withdrawAmount);
    event Whitelist(address indexed _address, uint16 duration);
    event PromoCodeAddition(address indexed _address, string name, uint16 commissionRate, uint16 discountRate, uint32 deadline);
    event Subscription(address indexed subscriber, uint16 duration, uint32 cost);
    event SubscriptionWithPromoCode(address indexed subscriber, string promoCode, uint16 duration, uint32 cost);

    error InvalidPlan(uint16 duration);
    error EmptyPromoCode();
    error PromoCodeAlreadyExists(string promoCode);
    error InvalidPromoCode(string promoCode);
    error ExpiredPromoCode(string promoCode);
    error ZeroDuration();

    bytes32 public constant MODERATOR_ROLE = keccak256("MODERATOR_ROLE");
    uint32 private constant ONE_DAY_SECONDS = 24 * 60 * 60;
    uint16 private constant RATE_MULTIPLIER = 1000;

    IERC20Metadata private _paymentToken;

    uint16[] private _planIndex;
    mapping(uint16 => Plan) private _plans; // duration => cost

    mapping(address => uint32) private _subscriptions; // subscriber => deadline
    mapping(address => string[]) private _addressPromoCodes; // address => promo code names
    mapping(string => PromoCode) private _promoCodes; // name => promo code

    constructor(address paymentTokenAddress, uint16[] memory planDurations, uint16[] memory planCosts) {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _paymentToken = IERC20Metadata(paymentTokenAddress);

        uint length = planDurations.length;
        for (uint i = 0; i < length; i++) {
            uint16 duration = planDurations[i];

            Plan storage plan = _plans[duration];
            plan.index = uint8(i);
            plan.cost = planCosts[i];

            _planIndex.push(duration);
        }
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

    function promoCodes(address _address) public view returns (string[] memory) {
        return _addressPromoCodes[_address];
    }

    function promoCode(string memory name) public view returns (PromoCode memory) {
        return _promoCodes[name];
    }

    function promoCodesInfo(address _address) public view returns (PromoCode[] memory) {
        string[] memory names = _addressPromoCodes[_address];
        PromoCode[] memory result = new PromoCode[](names.length);

        for (uint i = 0; i < names.length; i++) {
            result[i] = _promoCodes[names[i]];
        }

        return result;
    }

    function stateInfo() public view returns (address, uint16[] memory, uint16[] memory) {
        (uint16[] memory durations, uint16[] memory costs) = plans();
        return (address(_paymentToken), durations, costs);
    }

    function addressInfo(address _address) public view returns (bool, bool, uint32) {
        return (hasRole(MODERATOR_ROLE, _address), hasRole(DEFAULT_ADMIN_ROLE, _address), _subscriptions[_address]);
    }

    // Admin Actions

    function changePaymentToken(address _address, address withdrawAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        address oldAddress = address(_paymentToken);
        uint balance = _paymentToken.balanceOf(address(this));

        _paymentToken.transfer(withdrawAddress, balance);
        _paymentToken = IERC20Metadata(_address);

        emit PaymentTokenChange(oldAddress, _address, withdrawAddress, balance);
    }

    function withdraw() public onlyRole(DEFAULT_ADMIN_ROLE) {
        _paymentToken.transfer(msg.sender, _paymentToken.balanceOf(address(this)));
    }

    // Moderator Actions

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

    function setPromoCode(address _address, string memory name, uint16 commissionRate, uint16 discountRate, uint16 duration) public onlyRole(MODERATOR_ROLE) {
        if (bytes(name).length == 0) revert EmptyPromoCode();
        if (_promoCodes[name]._address != address(0)) revert PromoCodeAlreadyExists(name);

        uint32 deadline = uint32(block.timestamp) + uint32(duration) * ONE_DAY_SECONDS;

        PromoCode storage _promoCode = _promoCodes[name];
        _promoCode._address = _address;
        _promoCode.commissionRate = commissionRate;
        _promoCode.discountRate = discountRate;
        _promoCode.deadline = deadline;

        _addressPromoCodes[_address].push(name);

        emit PromoCodeAddition(_address, name, commissionRate, discountRate, deadline);
    }

    // Subscriber Actions

    function subscribe(uint16 duration) public {
        uint16 cost = _plans[duration].cost;

        if (cost == 0) revert InvalidPlan(duration);

        _paymentToken.transferFrom(msg.sender, address(this), cost * 10 ** _paymentToken.decimals());
        _updateDeadline(msg.sender, duration);

        emit Subscription(msg.sender, duration, cost);
    }

    function subscribeWithPromoCode(uint16 duration, string memory promoCodeName) public {
        uint16 cost = _plans[duration].cost;

        if (cost == 0) revert InvalidPlan(duration);

        PromoCode memory _promoCode = _promoCodes[promoCodeName];

        if (_promoCode._address == address(0)) revert InvalidPromoCode(promoCodeName);
        if (_promoCode.deadline < block.timestamp) revert ExpiredPromoCode(promoCodeName);

        uint tokenCost = cost * 10 ** _paymentToken.decimals();
        uint promoCodeAmount = tokenCost * _promoCode.commissionRate / RATE_MULTIPLIER;
        uint contractAmount = tokenCost - tokenCost * (_promoCode.commissionRate + _promoCode.discountRate) / RATE_MULTIPLIER;

        _paymentToken.transferFrom(msg.sender, _promoCode._address, promoCodeAmount);
        _paymentToken.transferFrom(msg.sender, address(this), contractAmount);

        _updateDeadline(msg.sender, duration);

        emit SubscriptionWithPromoCode(msg.sender, promoCodeName, duration, cost);
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
