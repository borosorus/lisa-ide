# AGENTS.md — LISA IDE v2 Final Polish

## Goal

Finish the current v2 visual editor by improving interaction quality, not by adding new visual-language features.

The existing architecture is sound:

```text
semantic graph
  ↓
React Flow projection
  ↓
validation / deterministic lowering
  ↓
@bosorus/lisa-evm
  ↓
generated source
  ↓
existing Worker compiler
  ↓
bytecode / artifact
```

Keep this architecture.

The remaining work should focus on:

- collision-free node creation
- real visual IF containment
- reclaiming canvas space
- removing redundant editing UI
- making contract function rows clearer
- preserving deterministic semantics and current ABI-output behavior

Do not expand v2 into wallet execution, simulation, or a larger node vocabulary.

---

## 1. Node placement

New nodes should not overlap each other by default.

Currently click-added contract calls and palette nodes use different placement strategies. Replace this with one canvas-aware placement mechanism.

Preferred behavior:

- add near the center of the current visible viewport
- inspect nearby existing node bounds/positions
- offset the new node until it has reasonable separation
- keep the position visible
- use the same mechanism for:
  - click-to-add contract functions
  - palette nodes
  - future programmatic node creation

A simple deterministic spiral/grid search around the viewport center is sufficient.

Do not add an auto-layout library.

Do not continuously rearrange existing user-positioned nodes.

Manual layout remains authoritative.

---

## 2. Visual IF containment

The current semantic `parent` field is correct, but IF membership should become visible and directly manipulable on the canvas.

An IF should behave as a lightweight visual container:

```text
┌ IF ─────────────────────────────┐
│ condition                       │
│                                 │
│   [ Vault.deposit ]             │
│                                 │
└─────────────────────────────────┘
```

Preferred interaction:

- IF node/container has the existing condition input
- nodes can be dragged into the IF body
- entering the container updates the semantic node's `parent`
- dragging a child out removes/changes its `parent`
- nested IFs should remain possible only if the existing semantic model already supports them cleanly
- child positions are presentation data only
- semantic lowering continues to use `parent`, not screen coordinates

Use React Flow grouping/parent-node capabilities only as a projection of the semantic `parent` relationship.

Do not make React Flow parent state canonical.

### Containment rules

Prevent or clearly reject:

- IF containing itself
- containment cycles
- assigning a node to a non-IF parent
- accidental semantic changes when merely moving nodes around outside container boundaries

Keep graph validation as the final semantic authority.

The canvas should make IF membership visually obvious enough that the sidebar inspector is not required to understand it.

---

## 3. Output panel

Visual mode should prioritize canvas space.

Default the Output panel to **collapsed** in visual mode.

Collapsed form should remain compact, e.g.:

```text
▸ Output                 ✓ compiled · 214 bytes
```

Expanded form keeps the current:

- bytecode
- disassembly
- generated source
- program hash
- artifact actions

Suggested behavior:

- normal successful compilation does not need to force the panel open
- compilation/graph errors may auto-open the panel if that materially improves discoverability
- user choice to open/close should otherwise be respected

Do not alter artifact or compilation semantics.

---

## 4. Inspector cleanup

Inline editing is now the primary editing path for:

- literals
- context values
- operations

Do not duplicate those controls in the inspector unless there is a clear secondary reason.

After visual IF containment is implemented, remove the `Inside IF block` selector from the normal workflow.

The inspector should become minimal.

Reasonable remaining uses:

- selected node identity
- contract/function details
- advanced/read-only diagnostics
- properties that genuinely do not fit on the node

If nothing meaningful remains for a node type, show compact details rather than duplicate editable controls.

It is acceptable to remove the inspector entirely if it no longer provides useful functionality.

---

## 5. Contract function rows

Function rows should remain compact but must distinguish overloads.

Do not display only `fn.name`.

Prefer the canonical signature:

```text
transfer(address,uint256)
balanceOf(address)
safeTransferFrom(address,address,uint256)
```

Use truncation for long signatures and expose the full signature with a tooltip/title.

Keep:

- read/write grouping
- function search
- click-to-add
- drag-to-add

Do not expand each function row into a large ABI editor.

---

## 6. Preserve automatic ABI outputs

The current direct ABI-output model is intentional.

Keep call outputs as ports on the call node.

Do not reintroduce normal Decode nodes.

Keep lazy lowering:

- only decode outputs that are actually connected/used
- decode immediately at the call site before later calls can replace returndata
- preserve deterministic generated source

Supported static output behavior should continue to cover the current safe set:

- uintN
- address
- bool
- bytesN

Unsupported dynamic outputs remain visible but non-connectable.

Do not add dynamic ABI decoding in this pass.

---

## 7. Preserve deterministic semantics

Presentation changes must not change program semantics.

In particular:

- moving a node must never change execution order
- resizing an IF container must never change execution order
- canvas coordinates must never participate in lowering
- only semantic graph relationships determine dependencies and scope
- node creation order may continue to break ties among independent nodes if that is the current deterministic rule

Add regression tests where appropriate.

---

## 8. Interaction polish

While touching these areas, fix small UX problems that are directly adjacent, but avoid broad redesign.

Good examples:

- selected-node highlight remains visible
- dragging controls does not move nodes
- child nodes inside IF containers remain easy to select/connect
- new nodes remain visible after creation
- library collapse does not cause bad viewport jumps
- canvas controls remain usable when Output/Library are collapsed
- error messages identify the relevant node where possible

Avoid adding new global concepts or dependencies unless necessary.

---

## 9. Suggested implementation order

1. Introduce one shared canvas-aware `spawnPosition` strategy.
2. Route contract click-to-add and palette node creation through it.
3. Project semantic IF `parent` relationships into React Flow grouping.
4. Implement drag-into / drag-out containment updates.
5. Add/update containment validation and tests.
6. Default Output to collapsed in visual mode.
7. Remove duplicated inspector controls and IF-parent selector.
8. Show canonical function signatures in contract rows.
9. Run responsive/browser polish.
10. Add regression tests for determinism and containment.

Keep each step independently working.

---

## 10. Testing

Prioritize tests for pure behavior:

- spawn position does not repeatedly return the same occupied location
- moving nodes does not affect generated source
- assigning/removing IF parents updates semantic scope correctly
- invalid IF cycles are rejected
- nested scope lowering remains deterministic
- existing ABI output lowering remains unchanged
- function signature rendering handles overloads

UI tests should cover important interactions only:

- repeated click-to-add produces separated nodes
- palette node creation uses visible canvas placement
- dragging a node into IF changes containment
- dragging it out removes containment
- Output starts collapsed in visual mode
- inspector no longer duplicates inline controls
- overloaded functions are distinguishable

Do not write brittle pixel-perfect tests of React Flow geometry.

---

## 11. Required local checks

Run:

```sh
npm install
npm test
npm run typecheck
npm run build
```

Then verify with `npm run dev` in a real browser:

1. Existing code mode is unchanged.
2. Repeatedly adding nodes does not stack them exactly on top of each other.
3. Added nodes appear within the visible canvas.
4. IF containers clearly show their child nodes.
5. Dragging into/out of IF updates generated source correctly.
6. Moving nodes without changing containment does not change generated source.
7. Connections to/from children inside IF remain usable.
8. Output starts collapsed and expands cleanly.
9. Collapsing Library/Output maximizes useful canvas space.
10. Contract overloads are visibly distinguishable.
11. Automatic ABI outputs still compile exactly as before.
12. Reload preserves graph semantics and positions.
13. Visual mode remains usable at typical laptop sizes and reasonable narrow widths.

---

## Non-goals

Do not add in this pass:

- wallet connection
- on-chain simulation
- execution
- Intereth integration
- explorer ABI fetching
- auto-layout engine
- new node families
- loops
- else branches
- reusable visual functions/modules
- arbitrary code → graph conversion
- dynamic ABI decoding
- a generic plugin/IDE architecture

The finish criterion is:

**The existing v2 feature set should feel spatially predictable and self-explanatory: new nodes appear cleanly, IF scope is visible on the canvas, contracts are easy to browse, and the canvas remains the dominant workspace.**
