// data.jsx — REAL on-chain data for the Coliseum finale deck.
// Source: coliseum-agent-trades.csv (75 trades) + coliseum-duel-results.csv (14 duels).
// All tx hashes are real Somnia Shannon testnet transactions.

const EXPLORER = "shannon-explorer.somnia.network";

// Agent → deck palette color + short tag
const AGENTS = {
  Degen:      { name: "THE DEGEN",       short: "DEGEN",   tag: "DG", color: "var(--magenta)" },
  Whale:      { name: "THE WHALE",       short: "WHALE",   tag: "WH", color: "var(--cyan)" },
  Quant:      { name: "THE QUANT",       short: "QUANT",   tag: "QT", color: "var(--purple)" },
  Scalper:    { name: "THE SCALPER",     short: "SCALPER", tag: "SC", color: "var(--amber)" },
  Diamond:    { name: "THE DIAMOND HAND",short: "DIAMOND", tag: "DH", color: "#b3a7d6" },
  Contrarian: { name: "THE CONTRARIAN",  short: "CONTRA",  tag: "CN", color: "var(--green)" },
};

// 75 real trades: [duel, market, round, agent, action, hash]
const TRADES = [
  [1,"SIM","R1","Quant","HOLD","0x705aa6663ac7c8e2b283812526898de4318ae497032a96e707a14bb82a0ce51f"],
  [1,"SIM","R1","Degen","BUY SOMI","0x434ed5a1574c90eeb09a36af41f1d8d8e71265ca59d6433ccd7f8aa5a5da2a16"],
  [1,"SIM","R2","Quant","HOLD","0x5b1a2fbc14cbdf579c5e3690d97135b75d21f3053081edfd03d28611de809261"],
  [1,"SIM","R2","Degen","BUY SOMI","0x1110f6b5e893e34be8348e6a3662687ec8f2bd1fe9e27113ecc739de1b9b82f1"],
  [1,"SIM","R3","Quant","HOLD","0x40402a8bc55a7d759f0d332196bef530afb848a3e4bbe0b71cc18a0104322838"],
  [1,"SIM","R3","Degen","BUY SOMI","0x582d5080530497f9879747f71a0360c76c1a9029c16376c8505d395c84c98126"],
  [2,"SIM","R1","Scalper","BUY SOMI","0x5e6c9a81499623e86ec8888092b08f61a049a30c3351e7fdbdcce723dc1847e3"],
  [2,"SIM","R1","Whale","BUY SOMI","0x4ad6254ac593b0a757c593817b3ec4770b074b68796890e6e87a18c45c5b2a4d"],
  [2,"SIM","R2","Whale","BUY SOMI","0xd51fec2b26b3bb3ae0a0727fe61c98086d83f52aa87c092679a591eabe660188"],
  [2,"SIM","R2","Scalper","SELL SOMI","0x2ce702a73dddb4a0c1b36fac4c6ee82a0366752c1d12577682e36f269a47ed4a"],
  [2,"SIM","R3","Whale","BUY SOMI","0xb2ad91074eca6fde6e754c50ce2f29b1bb92c3337ef7a84e18124b2dbc00927f"],
  [3,"SIM","R1","Contrarian","BUY SOMI","0xdbc05c7ec8455c38dd343e35bba33c8139bac7c06fc5bceb323300604d260566"],
  [3,"SIM","R1","Degen","BUY SOMI","0xa068164567d0e5d689d41859afdc64db2c6946e298adba1114964ca69ddad19b"],
  [3,"SIM","R2","Degen","BUY SOMI","0x68472e2e7a9b7235a48b834f207a6c406d21165fc620188bd777bbca8bb3eee6"],
  [3,"SIM","R2","Contrarian","SELL SOMI","0xfa3ff0d4567dff8c13cc56decd2c6495d134ec92ea7a1a81b5791c4098a6d1c8"],
  [3,"SIM","R3","Degen","BUY SOMI","0x26b5d0cace7f420b819a7f14342ef730556533375ceaa456aaa7896aad9d3621"],
  [4,"SIM","R1","Scalper","BUY SOMI","0xd0171a7229387b8aedf5bf96fc4316274830898a583538974c2071301eb87f53"],
  [4,"SIM","R1","Diamond","BUY SOMI","0x5a5145ecfb872bd97abcbfe99cb174e1466b3a68694932e47fd1947a051c21ee"],
  [4,"SIM","R2","Diamond","BUY SOMI","0xae5e1e317565969f81216240fb7b28e133a6fb9c1a13f419c2d356e6ed1b210f"],
  [4,"SIM","R2","Scalper","SELL SOMI","0x7dd25729ce93a8239b49d13c0768a1bfe782a56c8b9a95d71ee2aae4f4eeef5a"],
  [4,"SIM","R3","Diamond","BUY SOMI","0x4f86db2963c7aa63d37cf0ac647fda1a6cf3d64acc60e715b27d74118a6be3cf"],
  [5,"REAL","R1","Degen","BUY SOMI","0xf79d0dc38f8df07b7f78fd9300bb4875bc06d983f5b6a1f8f3bdc031a7e99435"],
  [5,"REAL","R1","Diamond","BUY SOMI","0x274c3c162984d5c93065ec5406f8c9fffd22c28227e84d103127bd8d9c993a97"],
  [5,"REAL","R2","Degen","BUY SOMI","0xa34c1cdebb86689711679a0bf6a114b5a2982bdfc41844fec619747ec51ddfa4"],
  [5,"REAL","R2","Diamond","BUY SOMI","0x668193b09a21e98d843519099ad00f6052316ee00d783d87cd076fb34147d48b"],
  [5,"REAL","R3","Diamond","BUY SOMI","0x3112e436287ea13ff4ecc0fb033d01f87d374e9679f8ed4c0d7e84883194a50d"],
  [5,"REAL","R3","Degen","BUY SOMI","0xb78704c64a24f8cbaf20c24aa5b37915753a691ead2941854d86d1b79ef5595e"],
  [6,"SIM","R1","Diamond","BUY SOMI","0xa41600406cbbe11e218e11a1fa3e030738231c5a26643c08bfd53b8dbfcf132f"],
  [6,"SIM","R1","Degen","BUY SOMI","0x16cde6797a82d1705793bd03543fd74acc5d40c0fad94de9e4076b16b7445c00"],
  [6,"SIM","R2","Diamond","BUY SOMI","0x3691f017d002282b8b8557aa4460998de531e638e4909ea626234b88abdd6fec"],
  [6,"SIM","R2","Degen","BUY SOMI","0xc6e79f3e67f967591b74172c7ed51b223db63aa3568e1a60f418a1683afcb9a8"],
  [6,"SIM","R3","Diamond","BUY SOMI","0xbc7d3821b5be594ae1bef7a587186737008226317e8498b6e2b2cf7b9fa20152"],
  [6,"SIM","R3","Degen","BUY SOMI","0x63d562e4ca7c2c4ff343b556c69a2f7644d8bd0cfab193db59a1f7a56935711d"],
  [7,"SIM","R1","Whale","BUY SOMI","0x1e2791fae6ea541b3543af8341967ffc455c83d6c2dc06a0251000167a8d5afb"],
  [7,"SIM","R1","Degen","BUY SOMI","0x8009841959bcc20102d023c012c3e50bde92275fd77647bda36944b5e1103468"],
  [7,"SIM","R2","Degen","BUY SOMI","0xe1087c98582c5d7f0c2ab7988a1822c12f1ec463c90515c3c02d4ec48432cbf3"],
  [7,"SIM","R2","Whale","BUY SOMI","0xca7e7ff2cb41dd9ac7597856d6f8979cdca56ecd8f97e36fa51d3c65e4e5c389"],
  [7,"SIM","R3","Whale","BUY SOMI","0xa93fb506ef40081f55eaf2f90b4c05fe757c98b2b148660e1b8e8f4673fb2cea"],
  [7,"SIM","R3","Degen","BUY SOMI","0xf2f88f56bac00e3587d944597243269c06fb2d5e83420ff871f4341e48f54a5b"],
  [8,"SIM","R1","Whale","BUY WETH","0x3a3533d8dbcd566b03df944bca582cd9c4f5ba5d70473adb79c850be8455fd7f"],
  [8,"SIM","R1","Degen","BUY WETH","0x9cb0d8db4ac91c21d8751785abbe7656c00324e2ac14bf683530a2b3e8536b5f"],
  [8,"SIM","R2","Degen","BUY SOMI","0x3b58c06af79ea6cf65ce1e29fe70eb8fe000d51a2200bfd4569601acfe155bf1"],
  [8,"SIM","R2","Whale","BUY WETH","0x54b427c37f1c51e512b3382d019cdecc4f1388c2b563823b397eed45cfc4ec8d"],
  [8,"SIM","R3","Degen","BUY SOMI","0xdf25ce8052b0f2093b1eb8b0fe84f78f2d12ccf3b20f0bc338892773737e7b43"],
  [8,"SIM","R3","Whale","SELL WETH","0x20eab1fe5f4d96469f1d9e56978c05758faab4e1b11835ede3777878db6093a5"],
  [8,"SIM","R4","Degen","BUY SOMI","0x99881fd74e6fc76ce7a6d7f3b499db7091ee12d0d6bf09ef4eddfb3cad42d3b1"],
  [8,"SIM","R4","Whale","BUY WETH","0x70124675e41292367514ff4c09fe33ecbc48f35d0b20ad23b130201e42fca254"],
  [8,"SIM","R5","Degen","BUY SOMI","0xe2051822000e3bc5e8ff5dc74a0d84bb93da47a0d678141fe0cfcc90ecbe5314"],
  [8,"SIM","R5","Whale","SELL WETH","0xb8f801e97039a46c4c57d8583e78c57b700bd64f302c3fec92bbb993e8389254"],
  [8,"SIM","R6","Degen","BUY SOMI","0x529fecb9c74fe7a9f97167cedbcecece7234ce08930241f402e2af706ee8c262"],
  [9,"SIM","R1","Quant","BUY SOMI","0xd6d97ad66d7d580ec7622f4bec49176550666477e660c155475946f45aa40817"],
  [9,"SIM","R1","Diamond","BUY SOMI","0x88561e5819e1c30b35ac0ab09f8de6cc89486ac3d21564b7ba356a669a6b889a"],
  [9,"SIM","R2","Diamond","BUY SOMI","0xb6fb395cf0f5b1bbf3c15f906cebc590ab0c7895681a0e13145d36bcde44ad26"],
  [9,"SIM","R2","Quant","BUY SOMI","0x9d83d4f41741db85d0c58704aa1fe4c9ebd22eccc327240472d68f4177c86583"],
  [9,"SIM","R3","Quant","SELL SOMI","0xf982c99079aec46b4cf6d79dc45a0d1876e8f6eff4c905ab811124dd5f430ce2"],
  [9,"SIM","R3","Diamond","BUY SOMI","0x37578366bdb411f752415a4c5ddd5563df70640033bfcf93cbad62a90c5318e2"],
  [10,"SIM","R1","Scalper","BUY SOMI","0x61c36b2fac2ff8ca20d6a4c877e6c1332f12d7f4daec818d9439fbc88585346d"],
  [10,"SIM","R1","Diamond","BUY SOMI","0x5be3c56db3abc406a7193397d7b00f90bc4b64dda106480f6bcd83d17eac5884"],
  [10,"SIM","R2","Scalper","SELL SOMI","0x761329268028b9064865f144d64d748163ddac203637d355d3233da1c49fa19c"],
  [10,"SIM","R2","Diamond","BUY SOMI","0xdada7510598c00f8e9d364239aa485435c3039313c3ffbc97b4ffe18dbe0dd8e"],
  [10,"SIM","R3","Diamond","BUY SOMI","0x739a8400a0f830a4ed60110e6c7e5987618ac5d073dfc4966591aae85a73e0bd"],
  [10,"SIM","R3","Scalper","BUY SOMI","0xf9cd5939b0ff5869e86dd29e630ab3999642e6710ebd1ed80eababa7d8922a1e"],
  [11,"SIM","R1","Scalper","BUY SOMI","0x9a493667840697ebefcf2a22fdbc93484f4e32047e9ffe5c153abe316b9d06f6"],
  [11,"SIM","R1","Contrarian","BUY SOMI","0x15381eec28451c2d585ce05c7ceed33f57db71706c18ca4660ec30cb814ffa68"],
  [11,"SIM","R2","Contrarian","SELL SOMI","0x816864da8c84885d2b456c87c42c222ffd7e0753c4e2465eddd0da960b0dce3b"],
  [11,"SIM","R2","Scalper","SELL SOMI","0x332d5ef2f6a95f1f39c8a9d8f08dfe9f110b3d63a6ff42ad17da3440f1e0f5ac"],
  [12,"SIM","R1","Contrarian","BUY SOMI","0xdb6f45b827372b049cf87d59fba2b3382d91bfe62fca3ccb2a8c98ed5470d3a7"],
  [12,"SIM","R1","Degen","BUY SOMI","0x70e5ee9104866b483f11be298900f9721befff81c66a759a2bd8c2cb2b45705a"],
  [12,"SIM","R2","Contrarian","SELL SOMI","0x43e5189adabb4e3bca710089a11021325ffc18d2ad973c80f426eb402455f9e8"],
  [13,"SIM","R1","Degen","BUY SOMI","0x60e9cbef51bc8927543b8830cb1a20acc1745588c19336cbc59fdb9254c32eea"],
  [13,"SIM","R1","Whale","BUY SOMI","0xe9ad38481bc2b38b703fd6bf6eae148d69c1a9767bc5230586ab716d0eed552c"],
  [14,"SIM","R1","Whale","BUY SOMI","0x40328f47db94694cf629dca6921612c7ed25dd17f3ffe10f53c686234682601b"],
  [14,"SIM","R1","Quant","HOLD","0xa032545c8265ec6bbe9038cd2c1053641dc3f8ed47380906bd455851b6684d7c"],
  [14,"SIM","R2","Quant","HOLD","0x6b3cc7532015d78f72c5c67244e2674b9cf12a2a966b414dfb7e5cf891c109c2"],
  [14,"SIM","R2","Quant","HOLD","0xaa3c1ce33ebfa0b6e3cead9f800ea4d142382f1f654a6650c8b0f519585da32d"],
].map(([duel, market, round, agent, action, hash]) => ({ duel, market, round, agent, action, hash }));

// 14 real duel results
const DUELS = [
  [1,"SIM","Degen","Quant","Quant",0.0002,0.0002,6,"0xf4fdd253317b5d0fc25fcb5a79c85d17a0ce9d45e78b00741f03cedb8b7fd5d8"],
  [2,"SIM","Scalper","Whale","Whale",0.0002,0.0002,5,"0x3b674e7e7134a498cab1522cc7997d9e51832ff1098d53f1fcbebff042fff418"],
  [3,"SIM","Degen","Contrarian","Degen",2.1337,2.1200,5,"0x3248819d99538b6958a555f86b8312fe6aa15f35e82dd710733ac408224bedd0"],
  [4,"SIM","Diamond","Scalper","Scalper",1.7263,1.7279,5,"0xed3c465263266fba97f2971616e368cff93f3ebf0a0fd5a46c2d94bd2b4546a1"],
  [5,"REAL","Degen","Diamond","Degen",0.3112,0.3112,6,"0x2b87afbd2c77d9d04dd0597af441a21ab2bdc2f927ef9ba32519c4dbea699b0b"],
  [6,"SIM","Degen","Diamond","Degen",1.6821,1.6821,6,"0xfc5722817f90dc9908bcd201c94763304340eb9a7ef22918d20515bfbfef458a"],
  [7,"SIM","Degen","Whale","Degen",0.5298,0.5298,6,"0x5708e31b855dc1b91e6021cec7362164c736dd1dc6d86d4f914a175805f8ce50"],
  [8,"SIM","Degen","Whale","Whale",5.3936,5.4349,11,"0xb401af3b70a25cb2414c91e5ccc85aa53bbbb50dcb81693b50e6c9bf31700f79"],
  [9,"SIM","Quant","Diamond","Diamond",0.0762,0.0773,6,"0xe7d1121abdf47d7ef2ce27ff4a5b96cd1a49b4714120a4c07df2b57a9cc6efe5"],
  [10,"SIM","Diamond","Scalper","Diamond",0.0044,0.0038,6,"0xe8f2b921f673821f48dcf1e5b5bf2101ff5a90f53bc113b097c2ab53a9451650"],
  [11,"SIM","Scalper","Contrarian","Scalper",0.0017,0.0017,4,"0x647fc973d211198e039c033d4319e97b84851c00553617ccda56dc81231caf32"],
  [12,"SIM","Contrarian","Degen","Degen",0.0000,0.0000,3,"0x11a7883e7669bf8fe340070e77d313fae1fc7dace75ac913621aed8187973fb5"],
  [13,"SIM","Degen","Whale","Degen",0.0000,0.0000,2,"0x31ed6cbc5ff45aa728e8c591e56609047c6ad7672c50559e7f4dacc1449b950d"],
  [14,"SIM","Whale","Quant","Quant",0.0000,0.0001,4,"0x8c5503a0509e8e04e83ea3a15ed9047ccf672b634170f91c1411bd730c5a665a"],
].map(([duel, market, a, b, winner, pa, pb, moves, tx]) =>
  ({ duel, market, a, b, winner, pa, pb, moves, tx }));

// Duel #8 fight tape — the divergence exhibit (Whale WETH vs Degen SOMI)
const DUEL8_TAPE = TRADES.filter(t => t.duel === 8);

// Deployed contracts — real Somnia Shannon testnet (chain 50312).
// Source: coliseum/frontend/lib/contracts.ts
const CONTRACTS = [
  { name: "ARENA",          role: "duel engine + vaults",   addr: "0x8813fef83ae3faa8d700c6fbcb8cf92de08ea726", color: "var(--magenta)" },
  { name: "MATCHMAKER",     role: "PvP queue + pairing",    addr: "0xadfc07d9e36622476860f8d27ba0a08e33e592e0", color: "var(--cyan)" },
  { name: "BOOKMAKER",      role: "AI odds · bet settle",   addr: "0x323cf312d93a5cbe575d30ef4d39a56ac362ece3", color: "var(--amber)" },
  { name: "FIGHTERREGISTRY",role: "AI personas · prompts",  addr: "0xefe3dd01c59b435bb688135f19db364ef09e90df", color: "var(--purple)" },
  { name: "DUELHISTORY",    role: "on-chain result ledger", addr: "0xa4aeab0164c9086dab7f9e5540c40f0935945fcd", color: "var(--green)" },
  { name: "dreamDEX POOL",  role: "SOMI/USDso · real CLOB", addr: "0x259fD6559214dd5aD3752322426eA9F9fABEFff4", color: "var(--amber)", ext: true },
];

// The load-bearing Somnia primitives (shown on the architecture stack)
const PRIMITIVES = [
  { title: "SOMNIA AGENTS", sub: "on-chain LLM inference", color: "var(--purple)" },
  { title: "dreamDEX CLOB", sub: "zero-fee order book",    color: "var(--amber)" },
  { title: "REACTIVITY",    sub: "self-ticking contracts", color: "var(--cyan)" },
];

// Fighter personas — real names/taglines/stats from FighterRegistry.sol.
// Each fighter is one on-chain system prompt; same LLM, different mind.
const PERSONAS = [
  { fid: "degen",      name: "THE DEGEN",        tag: "Send it. Always.",            agg: 5, pat: 1, rsk: 5, color: "var(--magenta)" },
  { fid: "whale",      name: "THE WHALE",        tag: "Size matters.",               agg: 4, pat: 3, rsk: 4, color: "var(--cyan)" },
  { fid: "quant",      name: "THE QUANT",        tag: "Mean reversion or nothing.",  agg: 1, pat: 5, rsk: 2, color: "var(--purple)" },
  { fid: "diamond",    name: "THE DIAMOND HAND", tag: "Never sell. Buy the dip.",    agg: 1, pat: 5, rsk: 3, color: "#b3a7d6" },
  { fid: "scalper",    name: "THE SCALPER",      tag: "1% × 1000 = victory.",        agg: 4, pat: 1, rsk: 3, color: "var(--amber)" },
  { fid: "contrarian", name: "THE CONTRARIAN",   tag: "Do the opposite.",            agg: 3, pat: 3, rsk: 3, color: "var(--green)" },
];

// Confirmed stats
const STATS = {
  trades: TRADES.length,        // 75
  duels: DUELS.length,          // 14
  fighters: 6,
  primitives: 3,
  finality: "0.101",            // seconds — from explorer screenshot
};

function shortHash(h) {
  return h.slice(0, 6) + "…" + h.slice(-6);
}

Object.assign(window, { AGENTS, TRADES, DUELS, DUEL8_TAPE, CONTRACTS, PRIMITIVES, PERSONAS, STATS, shortHash, EXPLORER });
