export interface SourceExample {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly source: string;
}

export const SOURCE_EXAMPLES: readonly SourceExample[] = [
  {
    id: 'conditional-balance',
    label: 'Conditional balance',
    description: 'Read a token balance and conditionally pass it into another call.',
    source: `const p = createProgram();
const TOKEN = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";

const balance = p
  .staticCall(TOKEN, encodeCall("balanceOf(address)", [SELF]))
  .uint256();

p.if(balance.gt(1000n), () => {
  p.call(VAULT, encodeCall("deposit(uint256)", [balance]));
});

return p;`,
  },
  {
    id: 'try-call',
    label: 'Try a call',
    description: 'Continue when a call fails, then decode its return value only after success.',
    source: `const p = createProgram();
const TOKEN = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";

const result = p.tryStaticCall(TOKEN, encodeCall("balanceOf(address)", [SELF]));
p.if(result.success, () => {
  const balance = result.uint256();
  p.tryCall(VAULT, encodeCall("deposit(uint256)", [balance]));
});

return p;`,
  },
  {
    id: 'minimal',
    label: 'Minimal program',
    description: 'Compile the smallest successful LISA program.',
    source: `const p = createProgram();
return p;`,
  },
  {
    id: 'raw-call',
    label: 'Raw calldata call',
    description: 'Call a target with calldata that was encoded elsewhere.',
    source: `const p = createProgram();
const TARGET = "0x1111111111111111111111111111111111111111";

p.call(TARGET, rawCalldata("0x12345678"));

return p;`,
  },
  {
    id: 'guard-and-hash',
    label: 'Guard, balance, hash',
    description: 'Revert unless the caller holds a balance, and pass a hashed constant through a call.',
    source: `const p = createProgram();
const TOKEN = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";
const CLAIM = "0x3333333333333333333333333333333333333333";

p.revertUnless(p.balance(CALLER).gt(1n));

const claimId = p.keccak("0x4c495341");
p.call(CLAIM, encodeCall("redeem(uint256)", [claimId]));

p.if(p.balance(TOKEN).gt(0n), () => {
  p.call(VAULT, encodeCall("settle()"));
});

return p;`,
  },
];

export const STARTER_SOURCE = SOURCE_EXAMPLES[0].source;
