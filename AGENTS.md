# AGENTS.md — LISA IDE v2 Final Interaction Pass

## Goal

Finish the visual editor by improving IF ergonomics, graph feedback, and small canvas interactions.

Do not add new visual-language features.

Do not add visual project import/export.

Do not add wallet execution, simulation, or Intereth integration in this branch.

The remaining work should focus on:

- persistent/resizable IF frames
- automatic IF expansion
- IF-aware node spawning
- graph diagnostics directly on the canvas
- small selection/port/spawn polish
- preserving existing deterministic semantics and ABI-output behavior

The semantic graph remains canonical. React Flow remains presentation only.

---

## 1. Persistent IF frame size

The current IF frame is derived too tightly from its children, which makes editing cramped.

Change IF presentation so the container has its own persistent visual size.

This size is presentation metadata only and must never affect lowering or execution order.

Recommended shape:

```ts
interface IfFrameSize {
  width: number;
  height: number;
}
```

Store this separately from semantic node data, alongside other presentation state.

A new IF should start with a comfortable default size, roughly in the range of:

- width: ~420px
- height: ~260px

Exact values may be adjusted to fit the current visual design.

The frame should not automatically shrink when children move.

---

## 2. Resizable IF containers

Users should be able to resize IF containers directly on the canvas.

Use React Flow resize facilities if they fit cleanly, but keep the resulting dimensions in project presentation metadata rather than in React Flow-only state.

Requirements:

- resize handle should be obvious but unobtrusive
- resizing must not change semantics
- child positions remain stable
- resizing a frame must not affect generated source
- nested IFs remain supported
- minimum size must preserve a visible header/body area

Do not introduce a general layout engine.

---

## 3. Automatic IF expansion

When a child approaches or crosses the right/bottom bounds of its IF, expand the frame automatically so the child remains comfortably inside.

Use padding around children.

Preferred behavior:

- moving a child outward can grow the IF
- growth should be smooth/predictable
- the IF never auto-shrinks
- nested IFs should propagate necessary growth outward if needed
- simple movement inside existing bounds should not resize the frame

Avoid making the user repeatedly push nodes around just to create room.

---

## 4. IF-aware node spawning

When an IF is selected, adding a node should prefer spawning it inside that IF.

This should apply to:

- palette nodes
- click-to-add contract functions

Use the existing collision-free spawn strategy, but scope the search to the IF body first.

Behavior:

1. determine selected IF
2. search for a free slot inside its body
3. if needed, expand the IF
4. assign the new node's semantic `parent`
5. place it at the chosen presentation position

If no IF is selected, keep the current viewport-centered spawn behavior.

Do not infer IF membership from arbitrary screen overlap during creation; assign it explicitly based on selected IF context.

---

## 5. Keep drag containment simple

Existing drag-into / drag-out IF behavior should remain.

Do not make containment depend on pixel-perfect boundaries.

Keep the current principle:

- semantic `parent` is authoritative
- React Flow grouping mirrors it
- dragging into an IF updates `parent`
- dragging out clears/changes `parent`

The new persistent frame size should improve this interaction by giving users more room.

---

## 6. Optional “Fit contents”

A small `Fit contents` action may be added for IF containers if it remains simple.

It should:

- resize the IF around its semantic descendants
- include comfortable padding
- never move children
- never change semantics

This is optional.

Do not spend significant complexity on it.

---

## 7. Graph diagnostics on canvas

Use the existing graph validation diagnostics to show errors where they occur.

Do not rely only on the Output panel.

Map `GraphDiagnostic.node` and `GraphDiagnostic.port` to visible canvas feedback.

Preferred visual feedback:

- invalid node: clear error outline
- invalid/missing port: error-colored handle/row
- selected invalid node: concise diagnostic text
- tooltip/title for additional detail if useful

Examples:

- missing call argument
- invalid connection type
- missing contract/function
- scope violation
- containment cycle
- unconnected required input

The user should be able to identify the broken node without reading an opaque global error such as `call3: input missing`.

Keep the Output panel as the full diagnostic summary.

---

## 8. Validation flow

Validation should remain pure and reusable.

Do not push validation logic into React components.

Preferred flow:

```text
project
  ↓
validateProject()
  ↓
GraphDiagnostic[]
  ├─ canvas highlighting
  └─ compile error summary
```

Avoid maintaining a second UI-specific validation system.

---

## 9. Selection polish

Make selected state clearer.

A selected node should be visually distinct from:

- normal nodes
- invalid nodes
- IF containers

If a node is both selected and invalid, both states should remain understandable.

Keep the styling subtle and consistent with the existing dark theme.

---

## 10. Port polish

Make port states clearer without adding clutter.

Useful distinctions:

- normal connectable
- selected/active connection target if available naturally
- invalid/missing input
- unsupported ABI output
- disabled/non-connectable

Do not add a large permanent legend unless the current UI clearly needs one.

Prefer self-explanatory row labels and tooltips.

---

## 11. Better spawn size estimation

The current spawn collision logic uses conservative fixed node sizes.

Call nodes can grow significantly with many inputs/outputs.

Improve spawn-size estimation using semantic information where practical.

For example:

- base call width stays fixed
- estimated height = header + rows for ABI inputs/outputs + padding
- literal/context/op nodes stay simple fixed estimates
- IF uses its stored frame size

Keep the calculation deterministic and pure.

Do not introduce DOM measurement unless absolutely necessary.

---

## 12. Preserve automatic ABI outputs

Do not change the current direct ABI-output model.

Keep:

- output ports directly on call nodes
- lazy decoding only for used outputs
- decoding immediately at the call site
- unsupported dynamic outputs visible but non-connectable

Do not reintroduce Decode nodes.

Do not add dynamic ABI decoding in this pass.

---

## 13. Preserve deterministic semantics

Presentation changes must never alter program semantics.

Specifically:

- moving nodes must not alter generated source
- resizing IFs must not alter generated source
- changing only frame dimensions must not alter generated source
- canvas coordinates must not participate in lowering
- execution order remains graph/dependency based
- IF scope remains semantic via `parent`

Add regression tests for this.

---

## 14. Suggested implementation order

1. Extend visual project presentation metadata with persistent IF frame sizes.
2. Add IF resize interaction.
3. Update IF geometry helpers to use stored frame size as the baseline.
4. Add automatic growth when children exceed bounds.
5. Update spawn logic to support selected-IF spawning.
6. Improve semantic node size estimation for collision checks.
7. Feed `validateProject()` diagnostics into canvas rendering.
8. Add node/port error states.
9. Improve selected-node styling.
10. Add optional Fit contents only if it stays small.
11. Add focused tests.

Keep each step independently working.

---

## 15. Testing

Do not add browser-testing requirements to this plan.

Focus on automated unit/component tests that are stable in the existing test environment.

Prioritize pure tests for:

- persisted IF frame size parsing
- frame resize state updates
- resize has no effect on generated source
- frame auto-expansion
- nested frame expansion
- IF-aware spawn selects a free position
- IF-aware spawn assigns the correct semantic parent
- spawning a large call uses a realistic estimated height
- graph diagnostics map correctly to node/port UI state
- moving/resizing nodes never changes generated source
- existing lazy ABI output decoding remains unchanged

UI/component tests should cover only stable behavior:

- IF resize callback updates presentation state
- selected IF causes new nodes to be created inside it
- invalid node gets an error state
- invalid port gets an error state
- selected node styling is applied
- unsupported ABI output remains visually distinct and non-connectable

Avoid brittle pixel-level geometry assertions.

---

## Non-goals

Do not add:

- visual project import/export
- wallet connection
- simulation
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
- general plugin architecture
- browser-testing instructions

The finish criterion is:

**IF blocks should feel like usable work areas rather than tight wrappers, graph errors should be visible where they occur, and adding/moving nodes should remain spatially predictable without changing LISA semantics.**
