# AGENTS.md — LISA IDE v2: ELSE Integration + Final Fixes

## Goal

Integrate the new structured `else` support from `@bosorus/lisa-evm@0.2.0` into both LISA IDE authoring modes, while preserving the current visual-editor architecture and completing the remaining containment fixes.

LISA EVM 0.2.0 exposes:

```ts
p.if(condition, thenBody, elseBody?)
```

Each branch body is a separate builder scope. Values created inside one branch are branch-local and cannot be used in the sibling branch or after the join.

The IDE should model this directly rather than synthesizing ELSE with lower-level jumps.

Keep the scope narrow:

- upgrade the IDE to `@bosorus/lisa-evm@0.2.0`
- allow code mode to evaluate three-argument `p.if`
- add optional ELSE branches to visual IF containers
- enforce branch-aware value scope
- generate the new builder form
- preserve current IF resizing/spawning/diagnostics
- finish drag/drop containment and order-independent IF depth

Do not add other visual-language features.

---

## 1. Toolchain upgrade

Update:

```json
"@bosorus/lisa-evm": "0.2.0"
```

Update the package lock accordingly.

The relevant upstream builder API is:

```ts
p.if(
  condition,
  () => {
    // then
  },
  () => {
    // else
  },
);
```

The third callback is optional.

Do not reproduce this behavior manually with raw AST/JMP/JZ in lisa-ide.

Use the published builder API.

### Artifact metadata

Update the IDE compiler/toolchain metadata from `0.1.0` to `0.2.0`.

Do **not** bump:

- `lisa-program` artifact format version
- `lisa-v1` ISA identifier

ELSE is a higher-level builder feature implemented through the existing ISA. It does not introduce a new VM opcode or artifact format.

---

## 2. Code-mode evaluator

The restricted evaluator currently allows `p.if(condition, callback)`.

Extend it to also allow:

```ts
p.if(condition, thenCallback, elseCallback)
```

Both callbacks must remain:

- zero-argument
- synchronous
- block-body arrow functions

Accept exactly:

- 2 arguments: condition + then
- 3 arguments: condition + then + else

Reject other arities.

Keep all existing evaluator restrictions.

Do not loosen the evaluator into general JavaScript execution.

Add focused evaluator/compiler tests for the three-argument form.

---

## 3. Visual IF model

Visual IF needs explicit branch semantics.

The current `parent` field says which IF owns a node, but is insufficient once an IF has two sibling scopes.

Use a small explicit branch model.

Recommended shape:

```ts
type IfBranch = 'then' | 'else';

interface NodeBase {
  id: string;
  parent?: string;
  branch?: IfBranch;
}

type IfNode = NodeBase & {
  kind: 'if';
  hasElse?: boolean;
};
```

Exact naming may vary, but preserve these invariants:

- top-level nodes have no `parent` and no branch
- a child of an IF belongs to exactly one branch
- existing/legacy IF children default to `then`
- `else` membership is valid only if the parent IF has ELSE enabled
- branch membership is semantic, not presentation metadata

Do not encode branch identity using screen coordinates.

Do not use React Flow parent state as canonical semantics.

---

## 4. Persistence migration

Existing saved visual projects must continue to load.

Migration rules:

- old IF node without ELSE state -> no ELSE
- old node with `parent` but no branch -> `then`
- top-level node -> no branch
- invalid branch values are rejected/dropped consistently with existing storage policy

Keep the current saved-project version if this can be migrated safely within the parser.

Do not introduce visual project import/export.

---

## 5. Visual IF UX

Keep the current IF container concept.

### IF without ELSE

Render one body region:

```text
┌ IF condition ─────────────────────┐
│ THEN                              │
│                                   │
│   [ nodes ]                       │
│                                   │
│                         + ELSE    │
└───────────────────────────────────┘
```

The existing body is the THEN branch.

### Enable ELSE

Provide a small, obvious `+ ELSE` action on the IF.

When enabled, display two clearly distinct branch work areas.

Recommended layout:

```text
┌ IF condition ─────────────────────────────────────┐
│ THEN                     │ ELSE                   │
│                          │                        │
│ [ then nodes ]           │ [ else nodes ]         │
│                          │                        │
└───────────────────────────────────────────────────┘
```

A side-by-side layout is preferred because sibling control-flow paths are visually obvious.

If implementation constraints make another layout substantially simpler, keep the same semantic distinction and readability.

When ELSE is enabled, grow the frame to a comfortable size if necessary.

Do not auto-shrink the frame afterward.

### Removing ELSE

If supporting removal, only allow it when the ELSE branch is empty, or use a deliberate confirmation flow.

Do not silently delete ELSE nodes.

Removal is optional for this pass; enabling ELSE is required.

---

## 6. Branch regions are presentation projections

Extend IF geometry helpers so a frame can expose semantic drop regions, conceptually:

```ts
interface Frame {
  rect: Rect;
  thenBody: Rect;
  elseBody?: Rect;
}
```

The exact structure may vary.

Rules:

- IF with no ELSE: THEN owns the current body
- IF with ELSE: body is divided into THEN and ELSE regions
- nested IF frames still work
- stored IF size remains presentation-only
- branch regions derive from IF state + frame geometry

Generated source must never read these rectangles.

---

## 7. Branch-aware containment

Containment must return both IF and branch.

Conceptually:

```ts
type ScopeTarget = {
  parent: string;
  branch: 'then' | 'else';
};
```

When a node is dragged:

- into THEN -> set parent + `then`
- into ELSE -> set parent + `else`
- between sibling branches -> update branch
- outside every IF -> clear parent + branch
- into a nested IF -> deepest valid nested branch wins

Keep cycle protection and existing parent validation.

Use one semantic transition helper for parent/branch changes where possible, e.g. `setNodeScope`, instead of scattering branch patches through React code.

---

## 8. Drag/drop creation must respect branch containment

The remaining v2 drag/drop correctness issue still applies.

When a contract function is dropped:

1. convert drop to flow coordinates
2. determine the deepest IF branch region under the drop
3. create the call node with that semantic parent/branch
4. place it near the drop point
5. preserve collision handling where practical
6. top-level drop remains top-level

Do not route contract drag/drop through a creation path that ignores containment.

Click-to-add and drag/drop should share creation semantics as much as possible.

---

## 9. IF-aware click spawning

Current selected-IF spawning should remain, but become branch-aware.

Preferred behavior:

- selected IF with no ELSE -> spawn into THEN
- selected THEN region -> spawn into THEN
- selected ELSE region -> spawn into ELSE

A lightweight UI-only selected-scope state is acceptable.

If no explicit branch region is selected, defaulting a selected IF to THEN is fine.

Use the current collision-free spawn strategy within the chosen branch body.

Grow the IF if required.

---

## 10. IF resizing and auto-growth

Preserve all current behavior:

- persistent frame size
- manual resize
- minimum size
- child-driven outward growth
- no automatic shrinking
- nested frame growth

Update growth calculations for the two-branch layout.

When ELSE is enabled, ensure each branch has a reasonable minimum work area.

Moving or resizing presentation data must never change generated source.

---

## 11. Branch-aware graph validation

This is a correctness requirement.

The current scope validator distinguishes IF nesting but not sibling branches.

Update scope identity to include branch.

A useful conceptual scope chain is:

```text
if1:then
if2:else
...
```

A value may flow only into the same scope or a descendant scope.

Therefore:

### Valid

A value created before an IF may be used in either branch:

```text
top-level value
  ├─> IF.then
  └─> IF.else
```

A THEN value may be used deeper inside THEN:

```text
if1:then
  └─ nested IF in then
```

### Invalid

THEN -> ELSE:

```text
if1:then value
  X
if1:else consumer
```

ELSE -> THEN is equally invalid.

Branch value -> after IF is invalid.

A nested branch-local value cannot escape to an ancestor branch.

Diagnostics should identify the consumer node and explain that the value belongs to a different/closed IF branch.

Do not rely on the upstream `LoweringError` as the normal UX for this.

Catch it at graph validation level.

---

## 12. Deterministic ordering

Keep current deterministic lowering rules.

Canvas coordinates and branch layout must not determine statement order.

Update ordering only as needed to support the branch-aware scope model.

The IF statement must be ordered after any top-level dependencies needed by:

- its condition
- THEN body
- ELSE body

Within each branch, preserve current deterministic dependency ordering.

Do not interleave THEN and ELSE source emission.

---

## 13. Generated visual source

Generate the existing two-argument form when ELSE is absent:

```ts
p.if(condition, () => {
  // then
});
```

Generate the 0.2.0 three-argument form when ELSE is enabled:

```ts
p.if(
  condition,
  () => {
    // then
  },
  () => {
    // else
  },
);
```

Readable formatting matters because generated source is part of the IDE's transparency/debugging model.

Nested IF/ELSE must recurse naturally.

Do not lower ELSE manually into extra low-level graph nodes.

---

## 14. Automatic ABI outputs remain unchanged

Preserve the existing ABI behavior:

- call outputs are direct ports
- only used outputs decode
- decode happens at the call site before returndata becomes stale
- supported static word outputs remain connectable
- unsupported dynamic outputs remain visible but non-connectable

The new branch model must respect builder scope:

- call outputs decoded inside THEN stay THEN-local
- call outputs decoded inside ELSE stay ELSE-local
- top-level decoded values may feed either branch

Do not reintroduce Decode nodes.

---

## 15. Order-independent nested IF depth

Keep the previously identified final fix.

IF depth calculation must not depend on node array order.

Compute depth by independently walking each IF's semantic parent chain.

For:

```text
ifA
  └─ ifB
      └─ ifC
```

depth must always be:

```text
ifA = 0
ifB = 1
ifC = 2
```

regardless of storage/creation order.

This becomes even more important with branch-aware hit testing.

Keep it deterministic and cycle-safe.

---

## 16. Diagnostics and selection

Preserve current canvas diagnostics:

```text
validateProject()
  ├─ compile validation
  └─ node/port error rendering
```

Branch scope errors should flow through the same system.

Do not create a separate visual-only validation engine.

Keep selected/invalid styling distinct.

---

## 17. Small optional polish

Only if straightforward:

- newly drag-dropped nodes become selected
- branch region being targeted during drag gets a subtle highlight
- contract function rows support Enter/Space activation

Do not redesign the contract library.

---

## 18. Testing

Do not add browser-testing requirements.

Focus on stable automated tests.

### Toolchain/evaluator

Test:

- dependency is 0.2.0
- artifact compiler metadata reports 0.2.0
- code evaluator accepts two-argument `p.if`
- code evaluator accepts three-argument `p.if`
- malformed third callbacks / wrong arity are rejected

### Model/storage

Test:

- old IF children migrate to THEN
- ELSE-enabled IF persists
- branch membership persists
- invalid branch state is rejected/repaired appropriately

### Validation

Test:

- top-level value -> THEN is valid
- top-level value -> ELSE is valid
- THEN -> nested THEN/ELSE descendants as allowed by ancestry
- THEN -> sibling ELSE is rejected
- ELSE -> sibling THEN is rejected
- branch value -> after IF is rejected
- nested branch value cannot escape
- branch scope behavior is independent of node order

### Generation

Test:

- IF without ELSE emits two-argument builder call
- IF with ELSE emits three-argument builder call
- empty ELSE, if allowed, emits deterministically
- nested IF/ELSE source compiles with 0.2.0
- branch-local calls/decoded outputs compile correctly
- generated output is independent of positions/frame sizes

### Canvas/containment

Test pure geometry/state where possible:

- THEN/ELSE branch hit testing
- deepest nested branch wins
- moving between THEN and ELSE changes semantic branch
- dropping a function in ELSE creates it in ELSE
- click spawning into selected branch
- frame growth still works with ELSE enabled
- IF depth works with reversed/shuffled nodes

Avoid brittle pixel-perfect tests.

---

## Non-goals

Do not add:

- visual project import/export
- wallet connection
- simulation
- execution
- explorer ABI fetching
- Intereth integration
- new VM instructions
- raw jump authoring
- loops
- reusable visual functions/modules
- arbitrary source -> graph conversion
- dynamic ABI decoding
- auto-layout
- generic plugin architecture
- browser-testing instructions

---

## Finish criterion

v2 is ready to freeze when:

- lisa-ide consumes `@bosorus/lisa-evm@0.2.0`
- code mode supports `p.if(condition, then, else)`
- visual IF can optionally expose distinct THEN and ELSE work areas
- nodes carry branch-aware semantic scope
- dragging/spawning correctly targets THEN or ELSE
- validation prevents values escaping/crossing sibling branches
- generated source uses the 0.2.0 builder API
- existing ABI decoding, diagnostics, resizing, and deterministic lowering remain intact
- nested IF depth and drop containment are order-independent

After this integration, prefer freezing/merging v2 rather than adding more visual functionality.
