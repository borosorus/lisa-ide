# AGENTS.md — LISA IDE v2

## Goal

LISA IDE v2 adds a **minimal visual coding mode** for building LISA programs without writing source by hand.

The visual editor should model useful LISA concepts — contracts, calls, values, return data, comparisons, and conditions — rather than exposing VM instructions directly.

A visual program must compile through the existing `@bosorus/lisa-evm` / `lisa-tooling` APIs into the **same LISA bytecode and artifact format** already produced by code mode.

Keep the application small. V2 is a visual authoring layer, not a general-purpose node IDE.

Long term, LISA IDE should remain usable standalone and may later connect a wallet for simulation/execution. Do not couple the v2 graph/project model to a wallet or execution provider.

---

## Stack

Keep the existing stack:

- Vite
- React
- TypeScript
- MUI
- CodeMirror 6
- Vitest + React Testing Library
- `@bosorus/lisa-evm`
- existing Web Worker compilation boundary

Add:

- `@xyflow/react` for the visual canvas and node interaction

Do not add another graph framework, global state library, router, backend, TypeScript language server, or wallet stack for v2 unless a concrete need appears.

---

## Product Model

V2 has two explicit authoring modes:

- **Code**
- **Visual**

They are separate authoring models.

Do **not** attempt arbitrary code → visual graph conversion.

A visual project may generate readable LISA source for inspection/export. If users later edit that generated source freely, it should be treated as a code project rather than kept bidirectionally synchronized with the graph.

Both modes converge at the existing compilation/artifact boundary:

```text
Code source ────────────────┐
                            ├─> lisa-tooling -> bytecode -> artifact
Visual graph -> lowering ───┘
```

---

## Visual Design

Prefer a simple layout:

```text
┌────────────────────────────────────────────────────────┐
│ LISA IDE                              Code | Visual     │
├───────────────────────────────┬────────────────────────┤
│                               │ Contracts / Nodes      │
│         Visual canvas         │                        │
│                               │ USDC                   │
│                               │   balanceOf            │
│                               │   approve              │
│                               │                        │
│                               │ Values / Logic         │
├───────────────────────────────┴────────────────────────┤
│ Generated source | Bytecode | Disassembly             │
└────────────────────────────────────────────────────────┘
```

Keep the interface visually consistent with v1.

The dominant mental model should be:

**contracts + values + control flow**

not opcodes or graphical assembly.

---

## Contract Resources

Contract instances are first-class project resources.

A contract should be added once using:

- name
- address
- ABI

Example conceptual model:

```ts
interface ContractResource {
  id: string;
  name: string;
  address: string;
  abi: readonly string[];
}
```

The UI should parse the ABI and list callable functions under that contract.

Prefer grouping functions into simple read/write sections when useful.

Users should be able to drag a function from the contract panel onto the visual canvas. The resulting node references the contract resource and function signature instead of copying ABI data into every node.

Changing a contract address should update all nodes referencing that resource.

For v2, support:

- paste ABI JSON
- address
- friendly contract name

Do not add explorer ABI fetching or Intereth integration yet.

---

## Semantic Graph

React Flow is only the rendering/interaction layer.

Do **not** use React Flow's node/edge structures as the canonical program semantics.

Define a small internal semantic graph model that can be tested independently of React.

Start with the smallest useful node vocabulary:

```ts
type LisaGraphNode =
  | ContractCallNode
  | ContextValueNode
  | LiteralNode
  | BinaryOperationNode
  | ReturnValueNode
  | IfNode;
```

Exact types may evolve, but keep the concepts small and explicit.

Likely context values:

- `SELF`
- `CALLER`
- `GAS`
- `TIMESTAMP`
- `SELFBALANCE`

Likely operations:

- add
- sub
- mul
- div
- lt
- gt
- eq

Do not create one node type per VM opcode.

Keep a low-level/raw call escape hatch only if clearly needed.

---

## Typed Connections

Use lightweight semantic port types to prevent obviously invalid connections.

Keep this intentionally small, for example:

- value
- address
- calldata
- condition
- call result

Do not implement a Solidity type system.

ABI-aware call nodes may expose argument ports using their ABI types, but graph compatibility rules should remain simple.

---

## Calls and Return Data

Dragging a contract function should create a semantic call node.

- view/pure functions should normally lower to `staticCall`
- state-changing/payable functions should normally lower to `call`

Call nodes should expose:

- contract/function identity
- ABI inputs
- native value when relevant
- return value outputs when supported

Return data should lower through the existing `lisa-tooling` helpers such as `uint256()`, `word()`, `bool()`, etc.

Do not reimplement ABI encoding or returndata semantics in the IDE.

---

## Control Flow

For v2, support the current simple LISA conditional model.

Prefer a compact **IF container/block** rather than generic branching wires:

```text
[ balanceOf ]
      │
      ▼
[ > 1000 ]
      │
      ▼
┌ IF TRUE ──────────────┐
│ [ Vault.deposit ]     │
└───────────────────────┘
```

This should lower naturally to `p.if(...)`.

Do not add loops, else branches, reusable functions, or general control-flow graphs in v2 unless required by the current LISA API.

---

## Data Flow and Ordering

Prefer data-flow relationships over explicit execution wires when dependencies already imply order.

Example:

```text
USDC.balanceOf -> amount -> comparison -> Vault.deposit
```

The graph-to-program lowering step is responsible for producing a valid deterministic execution order.

Reject:

- cycles
- missing required inputs
- references to missing contract resources
- ambiguous or impossible ordering
- invalid port connections

Errors should be understandable at graph level, not exposed as internal compiler failures when they can be caught earlier.

---

## Graph Lowering

Create a pure visual compiler/lowering layer:

```text
Visual project
    ↓
validate graph
    ↓
determine deterministic order
    ↓
build with lisa-tooling
    ↓
existing compile / artifact pipeline
```

This layer must be independent of React Flow and should have strong unit tests.

Do not emit raw LISA bytecode manually.

Do not duplicate ISA logic.

Use `@bosorus/lisa-evm` as the only source of LISA execution/compiler semantics.

---

## Generated Source

Visual projects should expose **read-only generated source**.

The generated source should be reasonably human-readable and resemble normal v1 authoring code:

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

Generated source is primarily for:

- transparency
- learning
- debugging
- exporting a visual project into code mode later

Do not make generated source editable while preserving visual synchronization.

The graph and generated source must compile to equivalent program bytes.

---

## Project Persistence

Extend browser persistence carefully so a visual project can store:

- authoring mode
- contract resources
- semantic graph
- small UI metadata needed to restore node positions

Keep semantic graph data separate from React Flow presentation metadata where practical.

Persist only serializable project state.

Do not persist compiler output as authoritative state; it can be regenerated.

Use localStorage unless size or real usage demonstrates a need for IndexedDB.

---

## Existing Compiler and Artifact Architecture

Preserve the v1 principles:

- `@bosorus/lisa-evm` is the compiler/ISA source of truth
- compilation/inspection stays behind the Worker boundary where applicable
- `lisa-program` remains the portable compiled artifact
- program bytes and independently checked hash remain execution-critical
- metadata remains descriptive

Visual mode must produce the same artifact format as code mode.

Do not introduce a separate "visual artifact" for execution.

A visual-project export may be added separately later if useful for editing/sharing projects.

---

## Future Standalone Execution

Do not implement wallet execution in this v2 branch.

However, keep project authoring independent from execution context so a later version can cleanly add:

```text
Author -> Compile -> Inspect
                     ↓
                Connect wallet
                     ↓
              Simulate / Execute
```

The graph must not depend on:

- connected account
- provider
- chain state
- LisaAccount deployment
- wallet permissions

Those belong to a future execution layer.

---

## Suggested Implementation Order

1. Add `@xyflow/react` and a minimal Visual mode shell.
2. Define visual project, contract resource, semantic graph, node, port, and edge types.
3. Add contract-resource creation from name + address + ABI.
4. Render contract functions in a simple sidebar and support dragging them onto the canvas.
5. Add literal/context nodes and lightweight typed connections.
6. Implement pure graph validation and deterministic lowering through `lisa-tooling`.
7. Add return-value and arithmetic/comparison nodes.
8. Add the IF container/block.
9. Add read-only generated source.
10. Feed visual compilation into the existing bytecode/disassembly/artifact UI.
11. Persist visual projects locally.
12. Add focused tests and browser polish.

Prefer incremental working slices over building the entire node system first.

---

## Testing

Pure semantic behavior should be tested without React Flow.

Prioritize tests for:

- ABI -> contract function resources
- graph validation
- port compatibility
- dependency ordering
- cycle rejection
- missing-input rejection
- contract resource references
- graph -> lisa-tooling lowering
- generated source
- equivalence between generated visual programs and expected compiled bytes
- persistence parsing / invalid saved state recovery

UI tests should cover only important interactions:

- add a contract
- drag/create a function node
- connect values
- delete/move nodes
- switch authoring modes
- compile visual graph
- see graph-level errors

Avoid brittle tests of canvas pixel positions or implementation details of React Flow.

---

## Required Local Checks

Before considering changes complete:

```sh
npm install
npm test
npm run typecheck
npm run build
```

Also run `npm run dev` and verify in a real browser:

1. Existing code mode still works unchanged.
2. Visual mode opens without affecting current source projects.
3. Contract ABI/address entry validates clearly.
4. Functions can be dragged/added and connected reliably.
5. Invalid connections are prevented or explained.
6. Moving nodes does not change program semantics.
7. Reload restores the visual project.
8. Generated source is readable and stable.
9. Visual compile produces expected bytecode/disassembly/artifact.
10. The canvas remains usable on a typical laptop viewport and degrades reasonably on smaller widths.

For behaviors that jsdom cannot verify meaningfully, test underlying pure logic and perform the browser check rather than adding brittle mocks.

---

## Non-goals for v2

Do not add:

- wallet connection
- on-chain simulation
- transaction execution
- Intereth integration
- explorer ABI fetching
- arbitrary code -> graph conversion
- editable synchronized generated source
- loops
- reusable user functions/modules
- package imports
- a Solidity type system
- custom VM/ISA compilation logic
- a general graphical programming platform

The v2 success criterion is simple:

**A user can add contracts, visually compose a useful LISA program from calls, values, return data, comparisons, and conditions, then compile/export exactly the same kind of LISA artifact as code mode.**
