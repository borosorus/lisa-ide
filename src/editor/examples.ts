export interface SourceExample {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly source: string;
}

/**
 * Compilable source patterns. Addresses and application-specific entry points
 * are called out in each example; compilation checks the LISA subset, not
 * whether those contracts exist on the connected chain.
 */
export const SOURCE_EXAMPLES: readonly SourceExample[] = [
  {
    id: 'conditional-balance',
    label: 'Transfer tokens with a balance check',
    description: 'Read the executor’s ERC-20 balance, pay the caller, and collect a 1% fee when both transfers are covered.',
    source: `const p = createProgram();
// Replace both addresses with contracts on the target chain. Amounts are token base units.
const TOKEN = "0x1111111111111111111111111111111111111111";
const FEE_RECIPIENT = "0x2222222222222222222222222222222222222222";
const PAYOUT = 1000000n;
const FEE = PAYOUT.div(100n);
const TOTAL = PAYOUT.add(FEE);

const balance = p
  .staticCall(TOKEN, encodeCall("balanceOf(address)", [SELF]))
  .uint256();

p.if(balance.gt(TOTAL.sub(1n)), () => {
  p.call(TOKEN, encodeCall("transfer(address,uint256)", [CALLER, PAYOUT]));
  p.call(TOKEN, encodeCall("transfer(address,uint256)", [FEE_RECIPIENT, FEE]));
});

return p;`,
  },
  {
    id: 'try-call',
    label: 'Try an ERC-20 payout',
    description: 'Handle both call reverts and ERC-20 false returns; queue a payout when the token does not accept it.',
    source: `const p = createProgram();
// Replace with an ERC-20 address. SELF must implement recordPayout and queuePayout.
const TOKEN = "0x1111111111111111111111111111111111111111";
const AMOUNT = 1000000n;

const transfer = p.tryCall(
  TOKEN,
  encodeCall("transfer(address,uint256)", [CALLER, AMOUNT]),
);

p.if(transfer.success, () => {
  // Standard ERC-20s return bool; a successful EVM call can still return false.
  const accepted = transfer.bool();
  p.if(accepted.eq(1n),
    () => { p.call(SELF, encodeCall("recordPayout(address,uint256)", [CALLER, AMOUNT])); },
    () => { p.call(SELF, encodeCall("queuePayout(address,uint256)", [CALLER, AMOUNT])); },
  );
}, () => {
  p.call(SELF, encodeCall("queuePayout(address,uint256)", [CALLER, AMOUNT]));
});

return p;`,
  },
  {
    id: 'quote-and-swap',
    label: 'Quote and swap ETH to USDT on Curve',
    description: 'Quote Curve Tricrypto2, then swap 0.01 ETH with 0.5% slippage protection. SELF receives USDT.',
    source: `const p = createProgram();
// Ethereum mainnet Curve Tricrypto2: coin 0 is USDT, coin 1 is WBTC, coin 2 is WETH.
// Curve's registry docs include this pool and its crypto-pool quote interface:
// https://knowledge.curve.finance/developer/amm/router/curve-registry-exchange
const POOL = "0xD51a44d3FaE010294C616388b506AcdA1bfAAE46";
const AMOUNT_IN = 10000000000000000n; // 0.01 ETH in wei

// Coin 2 is WETH in the pool; use_eth=true lets it accept native ETH as input.
p.revertUnless(SELFBALANCE.gt(AMOUNT_IN.sub(1n)));

// Tricrypto2 uses uint256 coin indices, supported directly by encodeCall.
const quote = p.staticCall(POOL, encodeCall("get_dy(uint256,uint256,uint256)", [2n, 0n, AMOUNT_IN]));
const expectedOut = quote.uint256();
p.revertUnless(expectedOut.gt(0n));
const minOut = expectedOut.mul(995n).div(1000n); // 0.5% slippage tolerance

// Send native ETH into the pool and receive USDT on SELF.
p.call(POOL, encodeCall("exchange(uint256,uint256,uint256,uint256,bool)", [2n, 0n, AMOUNT_IN, minOut, true]), AMOUNT_IN);

return p;`,
  },
  {
    id: 'lido-stake-eth',
    label: 'Stake ETH with Lido',
    description: 'Stake 0.01 ETH through Lido mainnet and receive stETH on SELF. SELF needs ETH for the stake and transaction gas.',
    source: `const p = createProgram();
// Ethereum mainnet Lido stETH contract; submit(address) mints stETH to its caller.
// Interface/deployment: https://docs.lido.fi/contracts/lido/
const LIDO = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const REFERRAL = "0x0000000000000000000000000000000000000000";
const AMOUNT = 10000000000000000n; // 0.01 ETH in wei

const stakeLimit = p.staticCall(LIDO, encodeCall("getCurrentStakeLimit()", [])).uint256();
p.revertUnless(SELFBALANCE.gt(AMOUNT.sub(1n)));
p.revertUnless(stakeLimit.gt(AMOUNT.sub(1n)));
p.call(LIDO, encodeCall("submit(address)", [REFERRAL]), AMOUNT);

return p;`,
  },
  {
    id: 'aave-supply-usdc',
    label: 'Supply USDC to Aave V3',
    description: 'Approve exactly 10 mainnet USDC to Aave V3, then supply it and receive aUSDC on SELF.',
    source: `const p = createProgram();
// Ethereum mainnet deployments: Aave address book and Pool interface.
// https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Ethereum.sol
// https://aave.com/docs/aave-v3/smart-contracts/pool
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AMOUNT = 10000000n; // 10 USDC (6 decimals)

const balance = p.staticCall(USDC, encodeCall("balanceOf(address)", [SELF])).uint256();
p.revertUnless(balance.gt(AMOUNT.sub(1n)));

// Grant the Pool an exact allowance, then consume it in this same execution.
p.call(USDC, encodeCall("approve(address,uint256)", [AAVE_POOL, AMOUNT]));
p.call(AAVE_POOL, encodeCall(
  "supply(address,uint256,address,uint16)",
  [USDC, AMOUNT, SELF, 0n],
));

return p;`,
  },
  {
    id: 'guard-and-hash',
    label: 'Guarded, time-limited claim',
    description: 'Check a deadline and caller balance, verify the contract’s stored bytes32 claim code, and claim.',
    source: `const p = createProgram();
const DEADLINE = 1900000000n;
// This contract exposes claimCode(address) -> bytes32 and claim(uint256).
// Replace with the commitment bytes expected by that contract.
const COMMITMENT = "0x4c4953412d636c61696d2d303031";

p.revertUnless(TIMESTAMP.lt(DEADLINE));
p.revertUnless(p.balance(CALLER).gt(0n));

const claimId = p.keccak(COMMITMENT);
const storedCode = p.tryStaticCall(SELF, encodeCall("claimCode(address)", [CALLER]));
p.if(storedCode.success, () => {
  const code = storedCode.bytes32();
  p.if(code.eq(claimId), () => {
    p.call(SELF, encodeCall("claim(uint256)", [claimId]));
  });
});

return p;`,
  },
  {
    id: 'native-payment',
    label: 'Send native currency',
    description: 'Send 0.001 ETH to a configured recipient when the executor has enough balance and gas.',
    source: `const p = createProgram();
// Replace with a recipient address on the target chain.
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const AMOUNT = 1000000000000000n; // 0.001 ETH in wei

p.revertUnless(SELFBALANCE.gt(AMOUNT.sub(1n)));
p.if(GAS.gt(30000n), () => {
  // Empty calldata plus a value performs a native-currency transfer.
  p.call(RECIPIENT, rawCalldata("0x"), AMOUNT);
});

return p;`,
  },
  {
    id: 'raw-call',
    label: 'Pre-encoded ERC-20 transfer',
    description: 'Read totalSupply with a raw selector, then submit pre-encoded transfer calldata to a configured token.',
    source: `const p = createProgram();
// Replace TOKEN and the recipient in the ABI-encoded transfer calldata.
const TOKEN = "0x2222222222222222222222222222222222222222";

const supply = p.staticCall(TOKEN, rawCalldata("0x18160ddd")).word(0);
p.if(supply.gt(0n), () => {
  p.call(TOKEN, rawCalldata(
    "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000002a",
  ));
});

return p;`,
  },
];

export const STARTER_SOURCE = SOURCE_EXAMPLES[0].source;
