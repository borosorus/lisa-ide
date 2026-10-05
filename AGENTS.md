# AGENTS.md — LISA IDE v2 Final IF/ELSE Flow Polish

## Goal

Finish the v2 visual editor by making IF/ELSE containment spatially unambiguous.

The current semantic model is already correct:

- IF children have semantic `parent` + `branch`
- ELSE uses `@bosorus/lisa-evm@0.2.0`
- generated source uses native `p.if(condition, then, else?)`
- frame sizes and positions are presentation-only
- validation enforces branch scope

Do not redesign that architecture.

The remaining work is purely about making the canvas obey the semantics cleanly.

The core invariant must be:

> Every scoped node is entirely inside exactly one IF branch content area. Every unscoped node is entirely outside every IF container.

There must be no ambiguous half-inside state.

---

## 1. Split IF geometry into explicit zones

An IF frame should have distinct presentation regions:

```text
┌ IF condition ───────────────────────────────┐
│                                            │
├ THEN ─────────────────┬ ELSE ───────────────┤
│                       │                     │
│   branch content      │   branch content    │
│                       │                     │
└───────────────────────┴─────────────────────┘
```

Model the frame geometry conceptually as:

```ts
interface Frame {
  rect: Rect;
  header: Rect;
  thenHeader: Rect;
  thenBody: Rect;
  elseHeader?: Rect;
  elseBody?: Rect;
  depth: number;
}
```

Exact names may differ.

Important rules:

- `header` contains the IF condition UI
- branch header strips contain THEN / ELSE labels only
- only `thenBody` and `elseBody` may contain child nodes
- the IF condition/header area is never a valid containment target
- branch labels are not valid content space
- generated source must never depend on these rectangles

The current single `IF_HEADER = 44` assumption should be revisited so the geometry matches the actual rendered condition UI.

---

## 2. Branch bodies need internal padding

A branch body should have explicit safe content bounds.

Use a small inset from:

- IF outer border
- branch header strip
- THEN/ELSE divider
- bottom edge

A child node must fit fully inside those safe bounds.

Do not allow nodes to visually touch or overlap the condition row or divider.

---

## 3. Stop using center-only containment as the final rule

The current center-point test is useful for inferring user intent, but it must not be the final position rule.

Use the dragged node center only to choose the intended target:

- THEN
- ELSE
- outside

After the target is chosen, normalize the whole node rectangle.

A node assigned to THEN must end with its full rectangle inside THEN content bounds.

A node assigned to ELSE must end with its full rectangle inside ELSE content bounds.

---

## 4. Centralize drop resolution

Introduce one pure helper for drag/drop normalization.

Conceptually:

```ts
resolveNodeDrop({
  project,
  node,
  desiredPosition,
  excludedFrames,
}): {
  position: Vec2;
  scope: ScopeTarget | null;
}
```

The helper should:

1. build current IF geometry
2. determine the deepest intended branch from the dragged node center
3. if targeting a branch:
   - assign that semantic scope
   - clamp/snap the whole node inside that branch body
   - expand the frame if necessary
4. otherwise:
   - clear semantic scope
   - if the node still intersects an IF frame, move it fully outside
5. return normalized position + semantic scope together

Keep this logic outside React components where practical.

Use the same rule for existing-node moves and contract drag/drop.

---

## 5. Scoped node normalization

When a node resolves to a branch:

- preserve its desired position as much as possible
- clamp only as much as necessary
- ensure the entire card fits inside the branch body
- preserve padding
- expand the IF if the branch genuinely needs more room

Do not let a scoped node end up:

- above the branch body
- over the IF condition/header
- over the THEN/ELSE divider
- partly outside the IF frame

If the node is too large for the current branch body, expand the IF before placement instead of allowing overlap.

---

## 6. Unscoped nodes must be clearly outside

If a node resolves to top-level scope, it must not remain visually inside or overlapping an IF frame.

This is especially important when dragging a child onto:

- IF header
- condition row
- branch label strip
- divider
- outer border

If semantic scope becomes `null` while the node rectangle still intersects an IF frame, push it the minimum distance necessary to sit fully outside that frame plus a small gap.

Choose the smallest translation that clears the frame.

Prefer stable deterministic behavior.

This eliminates states where a node looks visually inside IF but is semantically top-level.

---

## 7. Header drops are always outside

The IF header is not a branch.

Dropping a node onto the condition/header area must result in top-level scope.

After scope is cleared, normalize the position so the node is fully outside the IF frame.

Never keep a top-level node drawn over the condition/header area.

---

## 8. Divider behavior

The THEN/ELSE divider must behave as a clear semantic boundary.

If a dragged node center is:

- clearly left of divider -> THEN
- clearly right of divider -> ELSE

After branch choice, clamp the entire node into that branch.

Do not allow a final node rectangle to straddle the divider.

Optionally use a small dead-zone around the divider for intent detection if that improves predictability, but the final position must still belong completely to one branch or be outside.

---

## 9. Keep branch boundaries stable

Do not make normal child movement redefine the THEN/ELSE divider.

The current behavior where THEN content can push the divider and subsequently move ELSE content is harder to reason about.

Prefer:

- branch boundary derived from frame width/layout
- frame growth increases available workspace
- ordinary child movement does not move the divider
- existing ELSE children are not unexpectedly shifted just because THEN grew

A simple equal split for ELSE-enabled IFs is acceptable and preferred unless there is a strong reason otherwise.

Example:

```ts
dividerX = frame.x + frame.width / 2;
```

Respect minimum branch widths when resizing/growing.

---

## 10. Frame growth

Keep current persistent frame sizing.

When a child approaches or exceeds its branch safe bounds:

- grow right/down as needed
- maintain branch padding
- maintain minimum branch widths
- do not auto-shrink
- do not change semantics

For ELSE-enabled IFs, growth should preserve a predictable branch split.

Nested IF growth should continue to propagate outward.

---

## 11. Contract drag/drop should use the same normalization

When dragging a contract function from the library:

1. use the drop point as the desired position
2. resolve intended branch from IF geometry
3. normalize the full call-node rectangle
4. assign semantic `parent` + `branch`
5. if dropped on header/divider/outside, keep it top-level and fully outside IF frames

Do not maintain a separate containment interpretation for new call nodes.

---

## 12. Click-to-add remains branch-aware

Keep current selected-branch spawning behavior.

- selected THEN -> spawn fully inside THEN body
- selected ELSE -> spawn fully inside ELSE body
- selected IF without explicit branch -> default THEN
- no selected IF -> viewport placement

Use the same safe branch bounds as drag normalization.

---

## 13. Nested IFs

Nested IF nodes must obey the exact same invariant as any other node.

A nested IF frame must be entirely inside its parent branch body.

Its own header/THEN/ELSE regions then define containment for its descendants.

Deepest valid branch still wins.

Keep all cycle protection.

---

## 14. Presentation must remain separate from semantics

Preserve:

```text
semantic graph
  ├─ parent
  ├─ branch
  └─ dependencies

presentation
  ├─ positions
  └─ frame sizes

React Flow
  └─ projection only
```

Do not let geometry affect lowering.

Do not let React Flow `parentId` become canonical.

Do not let resizing/moving alone change generated source.

---

## 15. Validation

Keep the existing branch-aware semantic validation.

Do not add geometry rules to `validateProject()`.

Geometry normalization belongs to canvas/project transition logic, not program validity.

Semantic validation should continue to cover:

- cross-branch value flow
- escaping branch-local values
- invalid parents
- invalid ELSE membership
- graph cycles
- port validity

---

## 16. Optional drag feedback

If simple, show the target region during dragging:

- THEN highlight
- ELSE highlight
- outside/no-target state

This is presentation-only.

Do not build a complex drag-state system.

The final normalized position matters more than hover effects.

---

## 17. Testing

Do not add browser-testing requirements.

Add focused automated tests for pure geometry/state behavior.

Test:

- node dropped in THEN ends fully inside THEN body
- node dropped in ELSE ends fully inside ELSE body
- node dropped near divider never ends straddling it
- node dropped on IF header becomes top-level and is moved fully outside
- node dragged out of a branch becomes top-level and is moved fully outside
- top-level node cannot remain overlapping an IF after normalization
- too-large child causes frame expansion before placement
- nested IF is entirely inside its parent branch
- deepest nested branch wins
- branch boundary remains stable when THEN children move
- ELSE children are not shifted by ordinary THEN movement
- drop normalization is deterministic
- positions/frame sizes still do not affect generated source
- existing branch-aware validation/generation remains unchanged

Avoid brittle pixel-perfect component tests; prefer pure rectangle/helper tests.

---

## Non-goals

Do not add:

- new node types
- loops
- additional control-flow constructs
- visual project import/export
- wallet connection
- simulation
- execution
- Intereth integration
- explorer ABI fetching
- dynamic ABI decoding
- auto-layout
- generic plugin architecture
- browser-testing instructions

---

## Finish criterion

The visual IF/ELSE implementation is complete when:

- the condition/header region can never contain child nodes
- branch label areas can never contain child nodes
- every scoped node is fully contained inside exactly one branch body
- every unscoped node is fully outside every IF frame
- no node can visually straddle THEN and ELSE after a drag
- branch boundaries remain predictable
- contract drops and existing-node drags follow the same containment rules
- nested IFs obey the same spatial invariant
- generated LISA semantics remain unchanged by presentation geometry

After this pass, freeze v2 rather than adding more visual-flow features.
