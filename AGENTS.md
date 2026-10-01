# AGENTS.md — LISA IDE v2 Refinement

## Goal

Polish the existing visual-coding implementation so it feels simple, readable, and self-explanatory.

Do not redesign the project architecture. Keep the current semantic graph + React Flow projection + `@bosorus/lisa-evm` lowering model.

The main goals are:

- automatic ABI-aware outputs on call nodes
- larger, readable node cards
- direct editing of simple values/logic on canvas
- a bounded and collapsible right-side library
- compact contract browsing
- a stable canvas that does not grow with sidebar/output content

The visual editor should feel like:

**contracts + values + logic + control flow**

not VM plumbing.

---

## 1. Automatic ABI decoding

Remove explicit decode nodes from the normal visual authoring flow where the ABI already defines return values.

A call node should expose usable output ports directly from the function ABI.

Example:

```solidity
function balanceOf(address owner) view returns (uint256 balance)
```

should render conceptually as:

```text
┌ USDC · balanceOf ──────────────┐
│ owner   address  ○             │
│                                │
│              balance uint256 ○ │
└────────────────────────────────┘
```

The graph lowering layer should internally perform the appropriate `CallResult` decoding only when an output is used.

For v2, support visually decodable static word-sized outputs that map cleanly to current LISA tooling, including:

- `uintN`
- `address`
- `bool`
- `bytesN`

Do not add dynamic ABI decoding for:

- `string`
- dynamic `bytes`
- arrays
- tuples
- other dynamic structures

If a function has unsupported return values, show them in the node as unsupported/non-connectable rather than introducing raw-result plumbing into the normal UI.

Preserve ABI parameter/output names when parsing ABI. Use names in node labels and port labels whenever available. Fall back to type + position only when names are absent.

The explicit Decode/Return node type may remain internally during migration if useful, but it should no longer be part of the normal palette once direct ABI outputs work.

---

## 2. Node visual redesign

Current nodes are too small and port labels overlap.

Redesign nodes as small readable cards.

Call nodes should generally be around 220–260px wide and grow vertically based on their inputs/outputs.

Use row-based layouts rather than mathematically distributing absolute port labels over the node height.

Example:

```text
┌────────────────────────────┐
│ USDC                       │
│ balanceOf                  │
├────────────────────────────┤
○ owner              address │
├────────────────────────────┤
│ uint256             balance ○
└────────────────────────────┘
```

Guidelines:

- input handles align with input rows
- output handles align with output rows
- contract name and function name are visually distinct
- long labels truncate gracefully and expose the full text via tooltip/title
- node content must not overlap handles or neighboring labels
- node size should be driven by content rather than a tiny global minimum
- keep styling compact, dark, and consistent with v1

Simple nodes may stay smaller than call nodes.

---

## 3. Direct editing on canvas

Basic semantic nodes should be editable directly in the canvas.

Users should not need to discover the sidebar inspector for common edits.

Preferred behavior:

### Literal

Render type + editable value directly:

```text
┌ Literal ──────────────┐
│ uint256  [ 1000 ]    ○
└───────────────────────┘
```

Support the existing literal types:

- uint
- address
- bool

Keep validation behavior consistent with the semantic model. Invalid intermediate text may live locally in the component, but invalid values must not enter persisted project state.

### Operation

Render the operator directly as a select/control in the node.

Example:

```text
┌ Operation ────────────┐
○ left                  │
○ right          [  > ] ○
└───────────────────────┘
```

### Context

Render the current context source directly and allow changing it from the node:

- SELF
- CALLER
- GAS
- TIMESTAMP
- SELFBALANCE

### IF

Keep IF visually distinct but simple. Do not turn it into a general control-flow editor.

### Call

Call arguments should primarily remain connection ports.

For payable functions, make the native value input obvious.

The existing selected-node inspector may remain for secondary details and diagnostics, but basic authoring must not depend on it.

---

## 4. Stable visual workspace

The canvas must not grow vertically because the contract list, node palette, inspector, or output becomes large.

Use a bounded desktop workspace based on available viewport height.

Conceptually:

```text
Top bar
────────────────────────────────────────
Canvas                     Library
                           (scrolls)
────────────────────────────────────────
Output panel
```

Requirements:

- canvas height stays stable
- sidebar scrolls independently
- output content scrolls independently
- adding large contracts does not increase canvas/page height
- large projects remain usable without the whole page becoming one long document

Avoid hardcoding dimensions that only work on one screen size.

---

## 5. Right-side library

Replace the current long `Contracts / Nodes` document with a bounded library panel.

Recommended structure:

```text
Library
[ Contracts ] [ Nodes ]

+ Add contract

▸ USDC
  12 functions

▾ Vault
  Search functions...
  Read
    previewDeposit
  Write
    deposit

Values / Logic
  Literal
  Context
  Operation
  IF
```

The whole library panel should be collapsible so users can maximize canvas space.

On smaller screens, prefer a drawer/overlay or stacked layout rather than squeezing the canvas excessively.

Do not let sidebar content determine canvas dimensions.

---

## 6. Contract management

Do not show the full add-contract form permanently.

Use a compact `+ Add contract` action that opens a dialog or similarly contained form.

Contract creation still requires:

- friendly name
- address
- pasted ABI JSON

Once created, a contract should render compactly:

```text
▸ USDC    0xA0b8…eB48    14 funcs
```

Expanding the contract shows its functions.

Requirements:

- contract rows start collapsed
- support function search/filtering
- keep read/write grouping if useful, but subtle
- avoid rendering every function for every contract at once
- contract address editing/removal may live inside the expanded contract or a compact secondary action

Clicking a function should add it to the canvas as well as drag-and-drop.

Drag-and-drop remains supported.

Click-to-add should place the node at a sensible visible canvas position.

This also improves touch usability.

---

## 7. Node palette

Keep the palette intentionally small.

Normal v2 palette:

- Literal
- Context
- Operation
- IF

Contract calls come from contract resources.

Remove Decode from the normal palette once automatic ABI outputs are implemented.

Do not add one node per opcode.

Do not expose VM-level operations unless there is a concrete user-facing need.

---

## 8. Semantic model and lowering

Preserve the core architecture:

```text
Visual project
    ↓
semantic validation
    ↓
deterministic lowering
    ↓
@bosorus/lisa-evm / lisa-tooling
    ↓
generated source
    ↓
existing compiler Worker
    ↓
bytecode / artifact
```

React Flow must remain presentation only.

Do not move semantics into React Flow node data.

Do not emit raw bytecode manually.

Do not duplicate LISA ABI/compiler semantics.

If call outputs are moved directly onto call nodes, update:

- semantic graph model
- ABI parsing
- port generation
- validation
- deterministic lowering
- generated source
- persistence migration/parsing
- tests

Keep those changes explicit and small.

---

## 9. Output panel

The Output area should no longer consume an unbounded second page section.

Prefer a bounded/collapsible bottom panel.

Collapsed state may show a concise status such as:

```text
> Output   ✓ compiled · 214 bytes
```

Expanded state contains the existing:

- Bytecode
- Disassembly
- Generated source
- program hash
- artifact actions

Do not change artifact semantics.

---

## 10. UX principles

Prefer obvious interactions over hidden ones.

A user should be able to understand the core workflow without documentation:

1. Add contract
2. Add/drag function
3. Add literal/context values
4. Connect ports
5. Adjust values/operators directly
6. Compile

Use tooltips for truncated or technical details, not for essential controls.

Keep terminology ABI/LISA-friendly but avoid exposing VM internals unnecessarily.

Make invalid graph states understandable at graph level.

---

## 11. Non-goals

Do not add in this refinement:

- wallet connection
- simulation
- execution
- Intereth integration
- explorer ABI fetching
- arbitrary code → graph conversion
- loops
- reusable modules/functions
- dynamic ABI return decoding
- Solidity type system
- generalized raw-return programming
- a generic IDE/plugin architecture

Keep focus on polishing the current v2 visual workflow.

---

## 12. Suggested implementation order

1. Extend ABI metadata to preserve input/output names.
2. Move static decodable outputs directly onto call nodes.
3. Update validation/lowering/generated source and tests.
4. Remove Decode from normal palette.
5. Redesign node cards and port row layout.
6. Add inline editing for literals, operations, and context nodes.
7. Replace permanent contract form with Add Contract dialog.
8. Make contract rows collapsed/searchable.
9. Add click-to-add for functions.
10. Make library collapsible and independently scrollable.
11. Bound the visual workspace/canvas height.
12. Make Output collapsible/bounded.
13. Do responsive/browser polish.

Prefer completing each vertical slice with tests before moving to the next.

---

## 13. Testing

Prioritize pure logic tests for:

- ABI input/output names
- output type support
- automatic call output ports
- unsupported dynamic outputs
- graph validation
- lowering used return values
- multiple call outputs
- generated source
- persisted project migration/parsing

UI tests should cover:

- add contract dialog
- collapsed/expanded contracts
- function filtering
- click-to-add
- drag-to-add
- inline literal editing
- inline operation/context editing
- automatic call output rendering
- sidebar collapse
- output collapse

Avoid brittle pixel-level React Flow tests.

---

## 14. Required local checks

Run:

```sh
npm install
npm test
npm run typecheck
npm run build
```

Then verify with `npm run dev` in a real browser:

1. Existing code mode is unaffected.
2. Call nodes are readable with several inputs and outputs.
3. No port labels overlap.
4. ABI outputs connect directly without manual Decode nodes.
5. Unsupported dynamic returns are clearly non-connectable.
6. Literals/operators/context values can be edited directly on canvas.
7. Several large ABIs do not enlarge the canvas/page.
8. Contracts start compact and their function lists are searchable.
9. Sidebar collapse meaningfully increases canvas space.
10. Function click-to-add and drag-to-add both work.
11. Output panel does not destabilize canvas layout.
12. Reload preserves semantic graph and presentation state.
13. Generated source and compiled bytes remain deterministic.

The success criterion for this refinement is:

**The same v2 feature set should feel substantially simpler: users work directly with contract calls, decoded ABI outputs, values, logic, and IF blocks without manually managing decoding or fighting the layout.**
