# LISA IDE

A small browser IDE for writing, compiling, and inspecting LISA programs. It uses the published
[`@bosorus/lisa-evm`](https://www.npmjs.com/package/@bosorus/lisa-evm) package at version `0.3.0`.
The application is static and needs no backend. Wallet execution is optional and inert until a
deployment is configured — see [Wallet execution](#wallet-execution-optional).

Two authoring modes share one compile pipeline:

- **Code** — write a LISA program directly in the editor.
- **Visual** — compose a program from contract calls, values, comparisons, and IF blocks on a canvas.

```text
Code source ────────────────┐
                            ├─> lisa-tooling -> bytecode -> artifact
Visual graph -> lowering ───┘
```

## Visual mode

Add **contracts** once (name + address + pasted ABI JSON); their functions appear in the sidebar and
can be dragged onto the canvas. Fill value inputs from **context** nodes (`SELF`, `CALLER`, `GAS`,
`TIMESTAMP`, `SELFBALANCE`), **literals**, **operations** (`add`/`sub`/`mul`/`div`/`lt`/`gt`/`eq`), a
**balance** read of the address it receives, and a **hash** of the byte data typed on its card. A
balance reserves no slot and is re-read wherever it is consumed, so one that no
emitted statement reaches is an error rather than a silent no-op; a hash is
computed once and shared by everything that consumes it.
A **guard** reverts when its condition is false, the same way a failed call reverts.

Return data comes off the call node itself: every ABI output is an output port, and a static one-word
output (`uintN`, `address`, `bool`, `bytesN`) is connectable, while a type that is not decodable yet —
or an output whose position cannot be located — is shown disabled with the reason. Address-typed
outputs carry the address port kind so they prefer address slots. An **IF** node gates its body calls
on a condition; enabling **ELSE** adds a second branch region. Which branch a node belongs to is
stored on the node (`parent` plus `branch`) and never inferred from what overlaps it on screen; an
empty branch emits `() => {}`. Changing a contract address updates every node referencing it.

The graph is canonical; the canvas is a projection of it. Before compiling, the graph is validated at
graph level (cycles, missing inputs, invalid port types, IF-scope escapes) with node-addressed
messages that never reach the Worker. Valid graphs lower to readable, read-only **generated source**
(shown in the Output panel), and that source feeds the same Worker compile path code mode uses — so a
graph always compiles to exactly the bytes its generated source describes. Node positions never
affect program semantics; execution order follows data dependencies first and creation order second.

Projects (mode, code draft, contracts, graph, positions) persist in `localStorage` under
`lisa-ide.project.v1`, migrating an existing `lisa-ide.source.v1` draft on first load. Malformed
saved state falls back to a fresh project.

## Wallet execution (optional)

A compiled program can be executed through an EIP-7702 `LisaAccount` from the strip below the toolbar.
It is entirely opt-in: with no configuration the IDE still starts and still connects a wallet, and
every LISA action stays disabled behind a short "LISA deployment not configured" note.

| Variable | Meaning |
| --- | --- |
| `VITE_LISA_CHAIN_ID` | Chain the deployment lives on, decimal or hex |
| `VITE_LISA_RUNTIME_ADDRESS` | Deployed LISA runtime the LisaAccount delegatecalls into |
| `VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS` | LisaAccount implementation a delegation must point at |

Set them in `.env.local` (see `.env.example`). They are deployment configuration, not VM semantics,
which is why they live here rather than in `@bosorus/lisa-evm`. All three are required together and
validated before use: absent is a normal, unconfigured build, while a partial or malformed set —
including a chain id of `0` — is reported as an invalid configuration rather than guessed at. One
deployment on one chain is all v1 supports.

The flow is: connect an injected wallet → check it is on the configured chain → read the connected
account's code → accept it only if that code is exactly `0xef0100 ++ implementation` for the configured
implementation → call `lisaRuntime()` on the account and require it to equal the configured runtime →
check that the configured runtime address actually has code at it → **Execute program** → review the
destination account and the program hash → confirm → `executeLisa(program)` sent **to the connected
account itself** through its own delegated code → transaction hash, then receipt.

Anything else fails closed, each with its own reason:

- **Wrong network.** An account on another chain is never inspected as if it belonged to this
  deployment — the same address elsewhere is a different account. No code is read there at all. The
  strip names both chains and offers **Switch network**, which asks the wallet and only acts on that
  click; nothing switches by itself.
- **Runtime with no code.** The account naming a runtime proves intent, not existence, so an empty
  address that matches the configuration is its own failure state rather than a false "ready".
- No delegation, a foreign implementation, a malformed designator, or a runtime mismatch.

Nothing is sent
because compilation succeeded; submitting always follows an explicit click, the account and chain are
re-checked at that moment, and a failed or reverted transaction is never retried automatically. The
app never handles private keys, and the wallet layer only consumes the compile output the Worker
already produced.

An **imported artifact** is inspected, not executed. Its bytes fill the Output panel and its
disassembly is available, but it did not come from the source on screen, so **Execute program** stays
disabled until the next compile from the editor or canvas.

Native transaction value is fixed at `0` wei in this version. Installing a delegation ("Enable LISA")
is not implemented: the account must already be delegated to the configured LisaAccount.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

See [AGENTS.md](AGENTS.md) for the architecture constraints of the current phase.

## Authoring source

Write a JavaScript-compatible subset using pre-bound LISA helpers. CodeMirror provides syntax highlighting and completions; compilation runs in a Web Worker. The current source is kept locally in the browser, and the Source header includes a few small examples that can replace the draft.

```js
const p = createProgram();
const token = "0x1111111111111111111111111111111111111111";
const vault = "0x2222222222222222222222222222222222222222";
const balance = p.staticCall(token, encodeCall("balanceOf(address)", [SELF])).uint256();
p.if(balance.gt(1000n), () => {
  p.call(vault, encodeCall("deposit(uint256)", [balance]));
});
return p;
```

Available names: `createProgram`, `encodeCall`, `rawCalldata`, `SELF`, `CALLER`,
`GAS`, `TIMESTAMP`, and `SELFBALANCE`. The supported methods are `p.staticCall`,
`p.call`, `p.if`, `p.balance`, `p.revertUnless`, `p.keccak`, return-data
`word`/`uint256`/`bytes32`/`bool`, and value `add`/`sub`/`mul`/`div`/`lt`/`gt`/`eq`.
`p.balance(address)` reads the balance of the address you pass (SELFBALANCE stays
the account's own); it reserves no slot and re-reads wherever the value is consumed.
A read that reaches no emitted instruction — a bare statement, or a comparison
nothing uses — is refused rather than quietly compiled away.
`p.revertUnless(condition)` is a statement: it emits the same guard a failed call
emits, and a LISA revert carries no data. `p.keccak(data)` hashes constant data
written as `0x` hex and costs one slot — a digest is a word, so pass it to a
`uint256` argument or compare it, not to a `bytesN` argument, which must be a
compile-time constant. Source supports `const` bindings,
strings, numbers, bigints, booleans, arrays, calls, zero-argument block callbacks
for `p.if`, and a final `return p;`. It does not support imports, type annotations,
arbitrary JavaScript globals, loops, assignment, general property access, or
other JavaScript or TypeScript syntax. Addresses can be declared as hex strings.

Press **Compile** or **Ctrl/⌘ + Enter**. Compiler errors retain their source position and are marked in the editor. The IDE shows bytecode, its Keccak-256 hash, byte and instruction counts, and disassembly. It executes a program only through the optional wallet flow above, never as part of compiling.

## Artifact

**Export artifact** downloads `lisa-program.json`:

```json
{
  "format": "lisa-program",
  "version": 1,
  "isa": "lisa-v1",
  "program": "0x00",
  "programHash": "0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a",
  "compiler": { "name": "lisa-tooling", "version": "0.3.0" }
}
```

`program` is the execution-critical compiled bytecode. `programHash` is Keccak-256 of those bytes and is verified independently on import. Artifact format/version, ISA, compiler metadata, hash, and bytecode are validated before an imported program is decoded and displayed.

Imported artifacts are inspection-only: they show their bytecode, hash, size, and disassembly but do not attempt to recreate authoring source. Exporting an imported artifact preserves its original compiler metadata.

The artifact format is intentionally small: it carries the bytes, their hash, and the toolchain that produced them, and nothing about the session that produced them.
