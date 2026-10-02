# AGENTS.md — LISA IDE v2 Final Fixes

## Goal

Finish v2 with a very small final correctness pass.

Do not add new visual-language features.

Do not add browser-testing instructions.

Do not add visual project import/export, wallet execution, simulation, explorer integration, or Intereth work.

The branch is functionally complete. The remaining work is:

1. make drag/drop creation containment-aware
2. make nested IF depth calculation independent of node array order
3. optionally apply a few tiny accessibility/selection polish items if they stay small

After that, freeze v2.

---

## 1. Drag/drop contract functions must respect IF containment

Current click-to-add behavior is correct:

- selected IF -> spawn inside the IF
- semantic `parent` is assigned explicitly
- placement uses IF-aware collision handling

Drag/drop must have equivalent semantic behavior.

### Problem

A contract function dropped visually inside an IF currently goes through the generic call-node path and can remain top-level semantically.

That creates a mismatch between what the canvas shows and what the generated program means.

### Required behavior

When a function is dropped on the canvas:

1. convert the drop point to flow coordinates
2. determine whether the drop lands inside an IF body
3. choose the deepest valid IF when multiple IFs overlap
4. create the call node with that semantic `parent`
5. place it at or near the drop point
6. preserve collision handling where practical
7. if no IF contains the drop, create it at top level

Use the same containment rules already used for dragged existing nodes.

Do not infer semantics from React Flow parent state alone.

The semantic `parent` field remains authoritative.

### Important

Do not route drag/drop through a path that silently ignores containment.

Prefer one shared creation helper where possible so click-to-add and drag/drop cannot drift semantically.

---

## 2. Nested IF depth must not depend on array order

Review `iframes()` and any related containment helpers.

### Problem

IF depth currently depends on previously computed parent depth values. If nested IF nodes are stored in child-before-parent order, depth can be wrong.

Depth affects:

- deepest-container hit testing
- nested IF precedence
- inside-out frame computation

### Required behavior

Compute each IF depth independently by walking its semantic parent chain.

Example:

```text
ifA
  └─ ifB
      └─ ifC
```

Depths must always be:

```text
ifA = 0
ifB = 1
ifC = 2
```

regardless of node array order.

The calculation must be:

- deterministic
- cycle-safe
- independent of presentation positions
- independent of creation order

After depth is known, inside-out frame calculation may sort by depth descending.

Add regression tests with intentionally reversed/shuffled node order.

---

## 3. Preserve current architecture

Keep these boundaries intact:

```text
semantic graph
  ├─ parent / dependencies / contracts
  │
presentation metadata
  ├─ positions
  └─ IF frame sizes
  │
React Flow projection
```

Do not let:

- positions affect lowering
- frame sizes affect lowering
- React Flow parent state become canonical
- drag/drop UI state bypass project transitions

`generateVisualSource()` should remain unaware of IF geometry.

---

## 4. Preserve current validation and diagnostics

Keep the existing flow:

```text
validateProject()
  ├─ compile validation
  └─ canvas node/port diagnostics
```

Do not create a second validation system for drop behavior.

Containment transitions should use the same semantic rules already enforced by project state and validation.

---

## 5. Optional tiny polish

Only do these if they remain small and obvious.

### Select newly dropped node

After a function is drag-dropped, selecting/focusing the new node is useful and consistent with click-to-add.

### Keyboard activation for contract function rows

Function rows currently behave like buttons.

If straightforward, support keyboard activation with Enter/Space or use a semantic control that naturally provides this.

Do not redesign the contract list.

### Fit contents

Do not add unless it is truly trivial now.

It is not required for v2 completion.

---

## 6. Do not change automatic ABI outputs

Keep the current direct ABI output model exactly as-is:

- output ports live on call nodes
- used outputs decode lazily
- decoding happens immediately at the call site
- dynamic unsupported outputs remain visible but non-connectable

Do not reintroduce Decode nodes.

Do not add dynamic ABI decoding.

---

## 7. Do not change IF frame semantics

Keep:

- persistent presentation-only frame sizes
- manual resizing
- automatic outward growth
- no automatic shrinking
- selected-IF click spawning
- drag existing nodes into/out of IFs
- nested IFs

The only required IF change is making depth order-independent and making new drag-dropped functions honor containment.

---

## 8. Testing

Focus on stable automated tests.

Add/adjust tests for:

- dropping a contract function inside a top-level IF assigns that parent
- dropping inside nested IFs chooses the deepest IF
- dropping outside every IF creates a top-level node
- containment choice is independent of node array order
- nested IF depths are correct with reversed node order
- nested IF depths are correct with shuffled node order
- cycle-safe depth calculation does not hang
- drag/drop containment does not affect deterministic lowering beyond the intended semantic parent
- moving/resizing presentation metadata still does not affect generated source

Do not add browser-testing requirements.

---

## Non-goals

Do not add:

- new node types
- loops
- else branches
- visual functions/modules
- arbitrary source -> graph conversion
- visual project import/export
- wallet connection
- simulation
- execution
- explorer ABI fetching
- Intereth integration
- auto-layout
- dynamic ABI decoding
- generic plugin architecture

---

## Finish criterion

v2 is done when:

- a contract function dropped inside an IF is semantically inside that IF
- nested IF containment behaves correctly regardless of node storage order
- existing ABI decoding, diagnostics, resizing, spawning, and deterministic lowering remain intact

After these fixes, prefer freezing/merging v2 instead of adding more visual functionality.
