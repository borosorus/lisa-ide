# LISA IDE v1

## Goal

Build a small, browser-based IDE for authoring and compiling LISA programs.

The IDE should stay focused on **program creation and inspection**, not wallet execution or contract exploration. Intereth will remain the generic execution surface and can later consume LISA bytecode/artifacts.

The first version should prioritize a clean code workflow:

**LISA source → compile → bytecode → disassembly → export/copy**

Visual programming is explicitly out of scope for v1, but the architecture should not prevent adding it later.

## Stack

Use a deliberately small client-side stack:

- Vite
- React
- TypeScript
- MUI
- CodeMirror 6
- Vitest + React Testing Library
- `lisa-tooling` from npm `@bosorus/lisa-evm@0.1.0`
- Web Worker for source evaluation / compilation

Avoid adding routing, global state libraries, backend services, IndexedDB, Monaco, or a full TypeScript language service unless clearly required.

## Core Architecture

Keep the UI separate from compilation.

```text
Editor
  │
  ▼
Compiler Worker
  │
  ├─ evaluate supported source
  ├─ use lisa-tooling
  ├─ compile
  └─ disassemble
  │
  ▼
Compiled Artifact
  │
  ├─ bytecode
  ├─ program hash
  ├─ size / instruction metadata
  └─ disassembly
```

The main application must not expose wallet, provider, storage, or DOM access to compiler code.

For v1, support a small JavaScript-compatible authoring environment with pre-bound LISA helpers rather than arbitrary TypeScript modules or imports.

Typical source should look like:

```ts
const p = createProgram();

const balance = p
  .staticCall(TOKEN, encodeCall("balanceOf(address)", [SELF]))
  .uint256();

p.if(balance.gt(1000n), () => {
  p.call(VAULT, encodeCall("deposit(uint256)", [balance]));
});

return p;
```

## v1 UI

Keep the interface compact:

- code editor
- compile status / errors
- compiled bytecode
- byte size and basic metadata
- disassembly
- copy bytecode
- export program artifact

A simple split-pane editor/output layout is sufficient.

## Artifact

Define a small versioned artifact format independent from the UI.

At minimum it should contain:

```ts
{
  format: "lisa-program",
  version: 1,
  isa: "...",
  program: "0x...",
  programHash: "0x...",
  compiler: {
    name: "lisa-tooling",
    version: "..."
  },
  metadata?: {
    name?: string
  }
}
```

Treat `program` as the execution-critical payload. Metadata is descriptive only.

This format should later be consumable by Intereth.

## Implementation Direction

1. Initialize the Vite/React/TypeScript app and basic MUI layout.
2. Integrate CodeMirror with LISA-oriented syntax highlighting and a few useful completions.
3. Integrate `lisa-tooling` as the only source of LISA AST/compiler semantics.
4. Add a Web Worker compilation boundary with a small typed request/response protocol.
5. Implement source evaluation, compilation, disassembly, and useful error reporting.
6. Add bytecode/disassembly output and artifact export.
7. Add focused tests around compiler protocol, artifact generation, and basic UI behavior.
8. Document local development and the supported source environment.

## Constraints

- Do not duplicate LISA compiler or ISA logic inside the IDE.
- Do not add wallet execution in v1.
- Do not add the visual graph editor in v1.
- Do not over-engineer project persistence; localStorage is enough if persistence is added.
- Prefer pure functions and explicit data structures around compilation.
- Keep the app statically deployable.
- Keep the dependency surface small.

The result should be a useful minimal LISA authoring tool and a clean foundation for a later visual editor and Intereth interoperability.
