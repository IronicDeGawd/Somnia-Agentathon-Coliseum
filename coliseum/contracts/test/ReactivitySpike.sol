// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReactivitySpike — does a one-shot BlockTick actually fire once?
///
/// @notice Throwaway experiment. Coliseum disabled Reactivity after measuring
///         ~25.8 STT/hour per contract, but it had subscribed to `BlockTick`
///         with `eventTopics[1] = 0`, which the docs say means EVERY BLOCK. At
///         ten blocks a second and a turn every 600 blocks, that is ~600
///         wake-ups per turn, 599 of which do nothing. The docs also say a
///         NON-ZERO second topic fires once, at that block number. If true, the
///         cost argument collapses — so this measures it rather than trusting it.
///
/// @dev    Four unknowns this is built to answer:
///           1. does a non-zero block topic fire exactly once?
///           2. can a handler chain the next hop reliably?
///           3. how long after the target block does it actually arrive?
///           4. what does one hop really cost?
///
///         `firings` is counted separately from `hops` on purpose: if the topic
///         is ignored and it behaves like the every-block subscription, firings
///         races away from hops immediately and that is the answer.
///
///         Safety: hops are capped, gasLimit is deliberately small, and stop()
///         cancels the subscription. This spends real testnet STT.
interface IReactivity {
    struct SubscriptionData {
        bytes32[4] eventTopics;
        address    origin;
        address    caller;
        address    emitter;
        address    handlerContractAddress;
        bytes4     handlerFunctionSelector;
        uint64     priorityFeePerGas;
        uint64     maxFeePerGas;
        uint64     gasLimit;
        bool       isGuaranteed;
        bool       isCoalesced;
    }
    function subscribe(SubscriptionData calldata data) external returns (uint256 subscriptionId);
    function unsubscribe(uint256 subscriptionId) external;
}

contract ReactivitySpike {
    address public constant PRECOMPILE = 0x0000000000000000000000000000000000000100;

    address public immutable owner;

    /// Blocks between hops. Small, so the experiment finishes in minutes.
    uint64 public immutable strideBlocks;
    /// Stop chaining after this many hops, so a mistake cannot run forever.
    uint8  public immutable maxHops;

    uint256 public subscriptionId;
    uint8   public hops;        // how many times we asked to be woken
    uint32  public firings;     // how many times we WERE woken
    bool    public stopped;

    /// @param armedAtBlock the block we asked for; @param firedAtBlock where it landed
    event Fired(uint32 indexed firing, uint8 hop, uint64 armedAtBlock, uint64 firedAtBlock, uint256 balanceLeft);
    event Armed(uint8 hop, uint64 targetBlock, uint256 subscriptionId, uint256 balanceLeft);
    event ChainEnded(string reason, uint32 firings, uint256 balanceLeft);

    uint64 public armedFor;     // the block number in the topic we last set

    error NotOwner();

    constructor(uint64 _strideBlocks, uint8 _maxHops) payable {
        owner = msg.sender;
        strideBlocks = _strideBlocks;
        maxHops = _maxHops;
    }

    receive() external payable {}

    /// @notice Arm the first hop. Also the only place a target block is chosen,
    ///         so the "fires once at N" claim is tested exactly as documented.
    function arm() external returns (uint256) {
        if (msg.sender != owner) revert NotOwner();
        return _arm();
    }

    function _arm() internal returns (uint256 newId) {
        uint64 target = uint64(block.number) + strideBlocks;
        armedFor = target;

        IReactivity.SubscriptionData memory d = IReactivity.SubscriptionData({
            // THE WHOLE POINT: a block number here rather than bytes32(0).
            eventTopics: [
                keccak256("BlockTick(uint64)"),
                bytes32(uint256(target)),
                bytes32(0),
                bytes32(0)
            ],
            origin:                  address(0),
            caller:                  address(0),
            emitter:                 PRECOMPILE,
            handlerContractAddress:  address(this),
            handlerFunctionSelector: this.onEvent.selector,
            // Must outbid ambient subscription traffic or the handler is
            // deferred — which matters more here, with only one shot per hop.
            priorityFeePerGas: 10_000_000_000,
            maxFeePerGas:      50_000_000_000,
            // Small on purpose: this handler only counts and re-arms, and a
            // small ceiling bounds the damage if the topic is ignored.
            gasLimit:          500_000,
            isGuaranteed: false,
            isCoalesced:  false
        });

        (bool ok, bytes memory ret) = PRECOMPILE.call(abi.encodeWithSelector(IReactivity.subscribe.selector, d));
        if (ok && ret.length >= 32) {
            newId = abi.decode(ret, (uint256));
            subscriptionId = newId;
            hops += 1;
            emit Armed(hops, target, newId, address(this).balance);
        } else {
            emit ChainEnded("subscribe call failed", firings, address(this).balance);
        }
    }

    /// @notice The handler. Counts the firing, then books the next hop.
    ///
    ///         Note what this cannot do: if this call reverts or runs out of gas,
    ///         nothing re-arms and the chain is over, silently. An every-block
    ///         subscription would simply try again 100 ms later. That asymmetry
    ///         is the real cost of the one-shot form, and why anything relying on
    ///         it still needs a watchdog.
    function onEvent(address, bytes32[] calldata eventTopics, bytes calldata) external {
        if (msg.sender != PRECOMPILE) return;

        firings += 1;
        uint64 firedAt = eventTopics.length >= 2 ? uint64(uint256(eventTopics[1])) : 0;
        emit Fired(firings, hops, armedFor, firedAt, address(this).balance);

        if (stopped) return;
        if (hops >= maxHops) {
            emit ChainEnded("hop cap reached", firings, address(this).balance);
            return;
        }
        _arm();
    }

    /// @notice Arm the EVERY-BLOCK form — `eventTopics[1] = 0`, exactly what
    ///         Arena and Bookmaker shipped. Two things to learn: what it really
    ///         burns per second, and whether unsubscribe actually stops it. The
    ///         second matters most: "subscribe while a fight runs, unsubscribe
    ///         when it ends" is only safe if cancelling genuinely works. A
    ///         one-shot subscription expires by itself, so it can never prove it.
    function armEveryBlock() external returns (uint256 newId) {
        if (msg.sender != owner) revert NotOwner();
        armedFor = 0;

        IReactivity.SubscriptionData memory d = IReactivity.SubscriptionData({
            eventTopics: [keccak256("BlockTick(uint64)"), bytes32(0), bytes32(0), bytes32(0)],
            origin:                  address(0),
            caller:                  address(0),
            emitter:                 PRECOMPILE,
            handlerContractAddress:  address(this),
            handlerFunctionSelector: this.onEventCount.selector,
            priorityFeePerGas: 10_000_000_000,
            maxFeePerGas:      50_000_000_000,
            gasLimit:          500_000,
            isGuaranteed: false,
            isCoalesced:  false
        });

        (bool ok, bytes memory ret) = PRECOMPILE.call(abi.encodeWithSelector(IReactivity.subscribe.selector, d));
        if (ok && ret.length >= 32) {
            newId = abi.decode(ret, (uint256));
            subscriptionId = newId;
            hops += 1;
            emit Armed(hops, 0, newId, address(this).balance);
        } else {
            emit ChainEnded("subscribe call failed", firings, address(this).balance);
        }
    }

    /// @notice Handler for the every-block form: count only, never re-arm.
    function onEventCount(address, bytes32[] calldata, bytes calldata) external {
        if (msg.sender != PRECOMPILE) return;
        firings += 1;
    }

    /// @notice Cancel, and prove unsubscribe exists while we are here.
    function stop() external {
        if (msg.sender != owner) revert NotOwner();
        stopped = true;
        (bool ok, ) = PRECOMPILE.call(abi.encodeWithSelector(IReactivity.unsubscribe.selector, subscriptionId));
        emit ChainEnded(ok ? "unsubscribed" : "unsubscribe call failed", firings, address(this).balance);
    }

    function drain() external {
        if (msg.sender != owner) revert NotOwner();
        payable(owner).transfer(address(this).balance);
    }
}
