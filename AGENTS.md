# AGENTS.md

Keep LISA IDE small and browser-first. The IDE authors and inspects programs; it does not own wallet execution.

## Architecture rules

- Treat `@bosorus/lisa-evm` as the source of truth for LISA semantics, AST, compilation, decoding, and disassembly. Do not duplicate ISA or compiler logic here.
- Keep authored source inside the restricted allowlisted evaluator. Do not replace it with `eval`, `new Function`, arbitrary imports, browser globals, network access, or wallet/provider access.
- Compilation and bytecode inspection belong behind the Worker boundary. React/UI code should consume typed results.
- The artifact's `program` bytes and independently checked `programHash` are execution-critical. Other metadata is descriptive.
- Prefer small explicit data structures and pure helpers. Avoid adding global state, routing, backend services, or large IDE infrastructure without a concrete need.
- If dependencies change, update and commit `package-lock.json`.

## Required local checks

Before considering a change complete, run:

```sh
npm install
npm test
npm run typecheck
npm run build
```

For editor, Worker, storage, or artifact changes also run `npm run dev` and verify in a real browser:

1. Valid source compiles and Ctrl/Cmd+Enter works.
2. Invalid source highlights the reported line/column and the marker clears after editing.
3. Loading each example replaces the editor source and still compiles as expected.
4. Edited source survives a page refresh.
5. Exported artifacts can be imported back and show matching bytecode, hash, size, and disassembly.
6. Tampered hashes, malformed JSON, unsupported artifact/ISA versions, and invalid bytecode are rejected clearly.
7. Copy/export actions work and the layout remains usable at narrow viewport widths.

If a behavior cannot be meaningfully covered in jsdom (CodeMirror visuals, browser downloads, Worker bundling, responsive layout), keep the automated unit coverage for its underlying pure logic and document/perform the browser check rather than adding brittle mocks.
