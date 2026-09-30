# LISA IDE

A small browser IDE for writing, compiling, and inspecting LISA programs. It uses the published
[`@bosorus/lisa-evm`](https://www.npmjs.com/package/@bosorus/lisa-evm) package at version `0.1.0`.
The application is static and needs no backend or wallet.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

See [AGENTS.md](AGENTS.md) for architecture constraints and the browser checks expected after editor, Worker, storage, or artifact changes.

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

Press **Compile** or **Ctrl/⌘ + Enter**. Compiler errors retain their source position and are marked in the editor. The IDE shows bytecode, its Keccak-256 hash, byte and instruction counts, and disassembly. It does not execute programs.

## Artifact

**Export artifact** downloads `lisa-program.json`:

```json
{
  "format": "lisa-program",
  "version": 1,
  "isa": "lisa-v1",
  "program": "0x00",
  "programHash": "0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a",
  "compiler": { "name": "lisa-tooling", "version": "0.1.0" }
}
```

`program` is the execution-critical compiled bytecode. `programHash` is Keccak-256 of those bytes and is verified independently on import. Artifact format/version, ISA, compiler metadata, hash, and bytecode are validated before an imported program is decoded and displayed.

Imported artifacts are inspection-only: they show their bytecode, hash, size, and disassembly but do not attempt to recreate authoring source. Exporting an imported artifact preserves its original compiler metadata.

The artifact format is intentionally small so Intereth or another consumer can later accept the same payload without depending on LISA IDE state.
