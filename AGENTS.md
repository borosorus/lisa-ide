# AGENTS.md — LISA IDE Wallet v1

## Goal

Add the first wallet-enabled LISA IDE flow without changing the existing authoring/compiler architecture.

The first milestone is:

```text
author / visual graph
        ↓
compile LISA program
        ↓
connect wallet
        ↓
inspect connected account
        ↓
verify LisaAccount delegation + runtime
        ↓
executeLisa(program)
        ↓
show transaction status / receipt
```

Keep this implementation small, browser-only, and explicit.

Do not redesign the visual editor or compiler.

---

## 1. Wallet stack

Use:

- `@web3-onboard/react`
- `@web3-onboard/injected-wallets`
- `ethers`

Keep wallet connection/session concerns separate from LISA account protocol logic.

A small React wallet session layer is appropriate, for example:

```text
src/wallet/
  onboard.ts
  WalletSessionContext.tsx
```

The session should expose only what the app needs:

```ts
interface WalletSession {
  status: 'disconnected' | 'loading' | 'ready' | 'error';
  provider: ethers.BrowserProvider | null;
  signer: ethers.JsonRpcSigner | null;
  account: string | null;
  chainId: string | null;

  connectWallet(): Promise<void>;
  switchChain(chainId: string): Promise<void>;
}
```

Do not spread wallet-library state through unrelated components.

---

## 2. Keep LISA account logic pure

Create a small non-React module for LisaAccount interaction:

```text
src/lisa-account/
  config.ts
  inspect.ts
  execute.ts
  types.ts
```

These modules must not import:

- React
- MUI
- Web3-Onboard
- wallet UI components

Prefer plain TypeScript functions operating on an ethers provider/signer or simple RPC-compatible inputs.

This code should be easy to extract into a standalone package later if needed, but do not create a separate package yet.

---

## 3. Deployment configuration

Do not put deployed runtime/account addresses into `@bosorus/lisa-evm`.

Use app configuration for now.

Expected environment variables:

```env
VITE_LISA_RUNTIME_ADDRESS=0x...
VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS=0x...
```

Both are deployment configuration, not VM semantics.

Because no canonical deployment exists yet:

- the app must still start when these variables are absent
- wallet connection may still work
- LISA execution/delegation actions must be disabled
- show a concise "LISA deployment not configured" state
- validate configured addresses before using them

Do not hardcode temporary deployment addresses into source.

---

## 4. Account inspection

Add a pure inspection flow for the connected account.

The useful states are conceptually:

```ts
type LisaAccountStatus =
  | { kind: 'unconfigured' }
  | { kind: 'undelegated' }
  | { kind: 'lisa'; implementation: string; runtime: string }
  | { kind: 'other-delegation'; implementation: string }
  | { kind: 'invalid-lisa'; implementation: string; reason: string };
```

Exact naming may vary.

For an EIP-7702 delegated account, inspect the account code and parse the delegation designator:

```text
0xef0100 || implementation-address
```

When the implementation matches the configured LisaAccount implementation:

1. call `lisaRuntime()` on the connected account
2. compare the returned runtime with `VITE_LISA_RUNTIME_ADDRESS`
3. classify the account as ready only when both checks match

Do not execute LISA programs through:

- an undelegated EOA
- an unknown delegated implementation
- a LisaAccount bound to a different runtime

Fail closed and explain the mismatch.

---

## 5. First execution milestone: already-delegated accounts

Implement execution for an account that is already correctly delegated before implementing delegation installation.

The transaction is sent to the connected account itself:

```text
connected EOA
    │ transaction to self
    ▼
LisaAccount.executeLisa(program)
    │ delegatecall
    ▼
configured LISA runtime
```

Use the LisaAccount ABI boundary only:

```solidity
executeLisa(bytes program)
lisaRuntime() view returns (address)
```

Encode `executeLisa(program)` with ethers.

Do not duplicate or embed the LISA runtime ABI/instruction set here.

The compiled program bytes produced by the existing IDE are the execution payload.

---

## 6. Program source of truth

Execution must use the exact compiled output currently shown by the IDE.

Do not compile again inside the wallet layer.

Preferred flow:

```text
compile()
   ↓
CompileOutput
   ├─ program bytes
   ├─ hash
   └─ disassembly

Execute
   ↓
encodeExecuteLisa(CompileOutput.program)
```

If the authoring project changes after compilation, the current compiled output is already invalidated by the IDE; preserve that behavior.

Disable Execute when there is no current successful compile result.

---

## 7. Execution UI

Keep wallet/execution UI small.

A compact section is enough:

```text
Wallet

0x1234…abcd
Chain: 1

LISA
Status: Ready
Runtime: 0x...

[ Execute program ]
```

States should be explicit:

- wallet disconnected
- connecting
- deployment unconfigured
- undelegated
- delegated to another implementation
- LisaAccount runtime mismatch
- ready
- awaiting wallet confirmation
- transaction submitted
- confirmed
- reverted / failed

Do not introduce a large execution workspace in this phase.

---

## 8. Transaction lifecycle

For `executeLisa`:

1. require wallet session = ready
2. require LisaAccount status = ready
3. require current compile output
4. prepare transaction
5. show a small review/confirmation surface
6. call `signer.sendTransaction(...)`
7. show submitted transaction hash
8. await receipt
9. show confirmed/reverted state

Do not automatically retry failed transactions.

Do not submit anything merely because compilation succeeded.

Wallet submission must always follow an explicit user action.

---

## 9. Transaction value

`executeLisa(bytes)` is payable.

Support an optional native transaction value, but keep the first UI simple.

If implemented now:

- default to `0`
- use a clearly labeled ETH/native-value input
- validate before submission
- pass it as transaction `value`

Do not infer transaction value from the LISA program.

If this adds unnecessary UI complexity for the first pass, leave value fixed at `0` and document the limitation.

---

## 10. Delegation installation comes second

Do not make delegation installation a prerequisite for completing the first wallet milestone.

First prove:

```text
connect
→ inspect existing delegation
→ verify runtime
→ execute program
```

After that works cleanly, add an `Enable LISA` flow.

Delegation installation must be wallet-capability-driven.

Do not:

- manually request raw private-key signatures
- implement custom key management
- assume every injected wallet supports the same EIP-7702 flow
- silently replace an existing non-LISA delegation

If the wallet cannot install the configured delegation, show it as unsupported rather than inventing a proprietary workaround.

---

## 11. Future delegation API boundary

When delegation support is added, keep wallet-specific transport separate from account semantics.

A pure capability/result shape is preferred, conceptually:

```ts
type LisaDelegationCapability =
  | { kind: 'available' }
  | { kind: 'unsupported' }
  | { kind: 'unavailable'; reason?: string };
```

UI should render these states explicitly.

Keep the actual wallet request behind a small adapter/function rather than embedding RPC calls in React components.

---

## 12. Error handling

Normalize errors at the wallet/LISA boundary.

Useful categories include:

- wallet disconnected
- user rejected request
- wrong chain
- invalid deployment configuration
- unsupported delegation
- unknown existing delegation
- LisaAccount runtime mismatch
- transaction reverted
- RPC unavailable

Do not expose large raw provider error objects directly in the UI.

Preserve useful error messages and codes for debugging.

---

## 13. Keep compilation isolated

Do not move compilation out of the existing Worker architecture.

Wallet code must consume compile results; it must not become part of the compiler worker.

Keep:

```text
authoring
   ↓
compiler Worker
   ↓
CompileOutput
   ↓
wallet execution
```

No wallet/provider objects should cross the Worker boundary.

---

## 14. Security boundaries

The app never handles private keys.

All signing must remain in the connected wallet.

Before sending:

- verify connected account has not changed
- verify chain has not changed
- re-check LisaAccount readiness if session context changed
- execute only the exact current compiled program
- display the destination account and program hash in the confirmation UI

Never call the bare LISA runtime directly as the connected EOA execution path.

Execution must go through the authenticated LisaAccount account path.

---

## 15. Keep the initial implementation local

Do not create a shared npm package in this phase.

Keep wallet-independent LISA account helpers under `src/lisa-account/`.

Only extract them later after their API has been proven by actual use.

Avoid premature adapters or generic provider frameworks.

---

## 16. Tests

Do not add browser-testing requirements.

Add stable automated tests for:

### Configuration

- missing deployment configuration
- valid addresses
- malformed addresses

### Inspection

- undelegated account
- valid EIP-7702 delegation marker
- other implementation
- configured LisaAccount implementation
- correct runtime
- runtime mismatch
- malformed delegation code

### Execution

- correct `executeLisa(bytes)` calldata
- transaction targets the connected account itself
- program bytes are passed unchanged
- execution disabled without compile output
- execution disabled when account is not ready
- account/chain change invalidates readiness
- confirmed receipt state
- reverted receipt state
- user rejection is surfaced cleanly

Prefer pure tests around parsing, inspection, transaction preparation, and state transitions.

---

## 17. Adjacent cleanup

Update stale README information while working in this phase.

The README should accurately reflect:

- `@bosorus/lisa-evm@0.2.0`
- current IF/ELSE visual behavior
- current ABI output model
- the new optional wallet execution capability once implemented

Do not rewrite unrelated documentation.

---

## Non-goals

Do not add in this phase:

- backend services
- private-key handling
- account abstraction infrastructure beyond what LisaAccount already provides
- ERC-4337 bundler integration
- transaction batching
- complex execution-plan UI
- arbitrary smart-account plugins
- hardcoded deployment addresses
- a new shared npm package
- changes to the LISA VM/ISA
- changes to visual-language semantics
- browser-testing instructions

---

## Finish criterion for wallet v1

The first wallet milestone is complete when:

- the IDE can connect an injected wallet
- deployment addresses come from environment configuration
- the connected account's delegation is inspected safely
- LisaAccount implementation and runtime are verified
- a current compiled LISA program can be explicitly sent through `executeLisa(program)`
- transaction submission and receipt state are visible
- unsupported/mismatched account states fail closed
- wallet logic remains separate from compiler and visual-editor logic

Only after this is stable should delegation installation be implemented.
