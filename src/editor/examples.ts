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
    label: 'Quote, then swap',
    description: 'Use a fallible read-only quote, apply 0.5% slippage, then submit a swap only when the quote succeeds.',
    source: `const p = createProgram();
// Example router interface: quoteExactInput returns one uint256 amount.
const ROUTER = "0x2222222222222222222222222222222222222222";
const TOKEN_IN = "0x3333333333333333333333333333333333333333";
const TOKEN_OUT = "0x4444444444444444444444444444444444444444";
const AMOUNT_IN = 1000000n;

const quote = p.tryStaticCall(
  ROUTER,
  encodeCall("quoteExactInput(uint256,address,address)", [AMOUNT_IN, TOKEN_IN, TOKEN_OUT]),
);

p.if(quote.success, () => {
  const expectedOut = quote.uint256();
  const minimumOut = expectedOut.mul(995n).div(1000n);
  p.call(ROUTER, encodeCall(
    "swapExactInput(uint256,uint256,address,address)",
    [AMOUNT_IN, minimumOut, TOKEN_IN, TOKEN_OUT],
  ));
});

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
