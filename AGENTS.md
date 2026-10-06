# AGENTS.md — LISA IDE Wallet v1 Final Cleanup

## Goal

Keep the current wallet-v1 architecture intact.

Do not redesign the wallet layer, LisaAccount helpers, compiler integration, or execution UI.

This pass is only for a few final hardening/consistency fixes before testing against a real deployment.

---

## 1. Make deployment configuration chain-specific

Add:

```env
VITE_LISA_CHAIN_ID=
VITE_LISA_RUNTIME_ADDRESS=
VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS=
```

Extend deployment config so a configured deployment always includes:

```ts
{
  kind: 'configured';
  chainId: string; // normalized decimal chain id
  runtime: string;
  implementation: string;
}
```

Requirements:

- validate the chain id
- normalize hex/decimal input to a decimal string
- all three variables must be present for a configured deployment
- missing all variables remains the normal `unconfigured` state
- partial or malformed configuration is `invalid`

Do not support multiple deployments/chains yet.

One configured deployment is enough for wallet v1.

---

## 2. Add a wrong-chain execution gate

If the connected wallet chain does not equal the configured LISA deployment chain:

- do not inspect the account as a LisaAccount
- disable execution
- show a clear wrong-network state

Conceptually:

```ts
{ kind: 'wrong-chain'; expected: string; actual: string }
```

If straightforward, expose a small **Switch network** action using the existing wallet session method.

Do not automatically switch networks.

---

## 3. Verify the configured LISA runtime has code

A matching `lisaRuntime()` address is not sufficient by itself.

When inspection otherwise resolves to the configured LisaAccount/runtime pair, also check:

```ts
reader.getCode(config.runtime)
```

The account is ready only when the configured runtime address has non-empty contract code.

If runtime code is empty, fail closed with a specific state/reason.

Keep this inside the pure LisaAccount inspection layer.

Do not inspect or interpret runtime bytecode beyond checking that code exists.

---

## 4. Make imported-artifact execution policy explicit

Currently importing an artifact produces a `CompileOutput`, so the wallet panel can treat it like a locally compiled program.

For wallet v1, keep imported artifacts inspection-only.

Execution should only be enabled for output produced from the current code/visual authoring state.

Recommended implementation:

- track whether the current output came from `compile()` or `importArtifact()`
- pass an executable/current-program value to the wallet panel only for locally compiled output
- importing an artifact must leave **Execute program** disabled

Do not change the artifact format.

Do not add artifact execution in this pass.

---

## 5. Fix disconnected `switchChain()`

`switchChain()` must fail explicitly when there is no wallet/provider.

Do not use optional chaining that silently resolves without doing anything.

Return/throw a normalized wallet-disconnected error instead.

Keep chain-id validation as-is or tighten it if needed.

---

## 6. Preserve current architecture

Keep these boundaries exactly as they are:

```text
WalletSessionContext
  └─ wallet connection / provider / signer

src/lisa-account/
  └─ pure config / inspection / transaction preparation

compiler Worker
  └─ compilation only

WalletExecutionPanel
  └─ readiness / review / submission / receipt UI
```

Do not move wallet logic into the compiler.

Do not put React/Web3-Onboard imports into `src/lisa-account/`.

Do not create a shared npm package yet.

---

## 7. Preserve current pre-send hardening

Do not weaken the existing send path.

Keep:

- reviewed program/account/chain snapshot
- live account re-check before broadcast
- live chain re-check before broadcast
- fresh LisaAccount inspection before broadcast
- abort if program/account/chain changes during checks
- explicit user confirmation
- no automatic retry
- broadcast hash preservation when submission succeeds but tracking fails

---

## 8. README cleanup

Update wallet documentation to include:

- `VITE_LISA_CHAIN_ID`
- wrong-chain behavior
- runtime code verification
- imported artifacts remain inspection-only

Keep the documentation focused on this app.

Remove any stale wording that implies another application is a required or intended consumer.

Do not rewrite unrelated sections.

---

## 9. Tests

Do not add browser-testing requirements.

Add focused automated tests for:

### Configuration

- all three deployment variables missing -> unconfigured
- partial configuration -> invalid
- malformed chain id -> invalid
- hex chain id normalizes correctly
- decimal chain id normalizes correctly

### Execution gate

- matching configured chain proceeds to inspection
- wrong chain does not inspect account
- wrong chain disables execution
- switch-chain action is explicit if present

### Runtime verification

- matching runtime with code -> ready
- matching runtime address with empty code -> not ready
- runtime mismatch still fails before execution

### Imported artifact policy

- locally compiled output can execute
- imported artifact output cannot execute
- compiling after importing restores executable output
- editing current source/graph still invalidates executable output

### Wallet session

- `switchChain()` while disconnected rejects explicitly

Keep tests pure/component-level and deterministic.

---

## Non-goals

Do not add:

- delegation installation
- multiple deployment registries
- automatic network switching
- transaction batching
- simulation
- ERC-4337 work
- native-value UI
- artifact execution
- new visual-language features
- changes to LISA VM/tooling
- browser-testing instructions

---

## Finish criterion

This cleanup is complete when:

- deployment config is bound to one explicit chain
- wrong-chain wallets cannot be inspected/executed as ready
- the configured runtime is verified to contain code
- imported artifacts remain inspection-only
- disconnected chain switching fails explicitly
- existing wallet execution behavior and pre-send safety checks remain intact

After these fixes, proceed to real deployment testing before adding delegation installation.
