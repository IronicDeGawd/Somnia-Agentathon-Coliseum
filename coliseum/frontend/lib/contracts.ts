import { parseAbi } from 'viem';

// Addresses on Somnia Shannon testnet (Chain ID 50312)
export const CONTRACT_ADDRESSES = {
  Arena: '0x2f38647596cda697f8fd674430cb4c9b31eb6a1b' as const,
  Bookmaker: '0xdf5709661a3f16f4ef3ee8cc232a087f016dbf7f' as const,
  FighterRegistry: '0x5390b0656797b18258f2919a799abe956d21690f' as const,
  USDso: '0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171' as const,
};

// Compact modern human-readable ABIs for robust integration
export const ABIS = {
  Arena: parseAbi([
    'function duels(uint256 duelId) view returns (address creator, uint32 turns, uint32 poolMask, uint32 currentTurn, uint8 status, uint8 winnerSlot, uint256 quoteBalanceA, uint256 quoteBalanceB)',
    'function minDepositFor(uint32 turns) view returns (uint256)',
    'function startDuel(uint8 fighterA, uint8 fighterB, uint32 turns) external returns (uint256)',
    'function finalizeDuel(uint256 duelId) external',
    'function recoverFunds(uint256 duelId) external',
    'event TurnAdvanced(uint256 indexed duelId, uint32 indexed turn)',
    'event DuelResolved(uint256 indexed duelId, uint8 indexed winnerSlot, uint256 payoutA, uint256 payoutB)',
    'event FighterMoveRequested(uint256 indexed duelId, uint8 indexed slot, string prompt)',
  ]),
  
  Bookmaker: parseAbi([
    'function currentOdds(uint256 duelId) view returns (uint32 degenOddsBps, uint32 whaleOddsBps)',
    'function placeBet(uint256 duelId, uint8 fighterSlot, uint256 amount) external',
    'function settleBets(uint256 duelId) external',
    'event OddsUpdated(uint256 indexed duelId, uint32 degenOddsBps, uint32 whaleOddsBps)',
    'event BetPlaced(uint256 indexed duelId, address indexed bettor, uint8 indexed slot, uint256 amount)',
  ]),

  USDso: parseAbi([
    'function balanceOf(address account) view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ]),
};
