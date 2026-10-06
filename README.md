# LISA IDE

A small browser IDE for writing, compiling, and inspecting LISA programs. It uses the published
[`@bosorus/lisa-evm`](https://www.npmjs.com/package/@bosorus/lisa-evm) package at version `0.2.0`.
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
`TIMESTAMP`, `SELFBALANCE`), **literals**, and **operations** (`add`/`sub`/`mul`/`div`/`lt`/`gt`/`eq`).
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
| `VITE_LISA_RUNTIME_ADDRESS` | Deployed LISA runtime the LisaAccount delegatecalls into |
| `VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS` | LisaAccount implementation a delegation must point at |

Set them in `.env.local` (see `.env.example`). They are deployment configuration, not VM semantics,
which is why they live here rather than in `@bosorus/lisa-evm`; both are validated before use, and a
malformed value is reported rather than used.

The flow is: connect an injected wallet → read the connected account's code → accept it only if that
code is exactly `0xef0100 ++ implementation` for the configured implementation → call `lisaRuntime()`
on the account and require it to equal the configured runtime → **Execute program** → review the
destination account and the program hash → confirm → `executeLisa(program)` sent **to the connected
account itself** through its own delegated code → transaction hash, then receipt.

Anything else — no delegation, a foreign implementation, a malformed designator, or a runtime that
does not match — fails closed: Execute stays disabled and the mismatch is shown. Nothing is sent
because compilation succeeded; submitting always follows an explicit click, the account and chain are
re-checked at that moment, and a failed or reverted transaction is never retried automatically. The
app never handles private keys, and the wallet layer only consumes the compile output the Worker
already produced.

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
`p.call`, `p.if`, return-data `word`/`uint256`/`bytes32`/`bool`, and value
`add`/`sub`/`mul`/`div`/`lt`/`gt`/`eq`. Source supports `const` bindings,
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
  "compiler": { "name": "lisa-tooling", "version": "0.2.0" }
}
```

`program` is the execution-critical compiled bytecode. `programHash` is Keccak-256 of those bytes and is verified independently on import. Artifact format/version, ISA, compiler metadata, hash, and bytecode are validated before an imported program is decoded and displayed.

Imported artifacts are inspection-only: they show their bytecode, hash, size, and disassembly but do not attempt to recreate authoring source. Exporting an imported artifact preserves its original compiler metadata.

The artifact format is intentionally small so Intereth or another consumer can later accept the same payload without depending on LISA IDE state.
