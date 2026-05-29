// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20M {
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Arena stub for Matchmaker unit tests only.
contract MockArenaMatchmaker {
    IERC20M public immutable usdso;

    uint256 public constant PLATFORM_FEE = 1e18;
    uint256 public lastDuelId;
    uint256 public activeDuelId;
    bool    public busy;

    struct DuelRecord {
        uint8   fighterA;
        uint8   fighterB;
        address creator;
        uint8   status;      // 1=Active, 3=Resolved
        uint8   winnerSlot;  // 255=unset
        uint256 pot;
    }
    mapping(uint256 => DuelRecord) private _duels;

    constructor(address _usdso) { usdso = IERC20M(_usdso); }

    // When busy=true, set a fake activeDuelId with status=Active so Matchmaker
    // sees Arena as occupied via _arenaFree() → activeDuelId != 0 && status != Resolved
    function setBusy(bool _busy) external {
        busy = _busy;
        if (_busy && activeDuelId == 0) {
            // Plant a fake active duel
            activeDuelId = 999;
            _duels[999] = DuelRecord(0, 0, address(0), 1, 255, 0); // status=Active
        } else if (!_busy && activeDuelId == 999) {
            activeDuelId = 0;
        }
    }

    function resolveDuel(uint256 duelId, uint8 winnerSlot) external {
        _duels[duelId].status     = 3;
        _duels[duelId].winnerSlot = winnerSlot;
        if (activeDuelId == duelId) activeDuelId = 0;
    }

    function minDepositFor(uint16) external pure returns (uint256) { return 2e18; }

    function startDuel(uint8 fA, uint8 fB, uint16) external returns (uint256 duelId) {
        require(!busy, "arena busy");
        uint256 required = 2e18 + PLATFORM_FEE;
        usdso.transferFrom(msg.sender, address(this), required);
        duelId = ++lastDuelId;
        activeDuelId = duelId;
        _duels[duelId] = DuelRecord(fA, fB, msg.sender, 1, 255, required - PLATFORM_FEE);
    }

    function recoverFunds(uint256 duelId) external {
        DuelRecord storage d = _duels[duelId];
        require(d.status == 3, "not resolved");
        require(d.creator == msg.sender, "not creator");
        uint256 amt = d.pot;
        d.pot = 0;
        usdso.transfer(msg.sender, amt);
    }

    // Returns tuple matching ArenaTypes.Duel field order exactly.
    // Matchmaker reads: [8]=status, [12]=winnerSlot
    function duels(uint256 duelId) external view returns (
        uint8, uint8, address, uint256, uint256, uint16, uint16, uint8,
        uint8,    // [8] status
        uint256, uint8[2] memory, bool,
        uint8     // [12] winnerSlot
    ) {
        DuelRecord storage d = _duels[duelId];
        uint8[2] memory la;
        return (d.fighterA, d.fighterB, d.creator, 0, 0, 0, 0, 0,
                d.status, 0, la, false, d.winnerSlot);
    }
}
