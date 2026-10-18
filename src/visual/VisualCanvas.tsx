import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import {
  Background, Controls, Panel, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LisaNode, NodeEditContext, portsForNode, type NodeEditApi } from './flowNodes';
import { canConnect } from './ports';
import { absolutePosition, iframes, normalizeDrag } from './containment';
import { indexDiagnostics, type GraphDiagnostic } from './validate';
import { tokens } from '../theme/tokens';
import type { GraphNode, IfFrameSize, ScopeTarget, Vec2, VisualProject } from './model';
import { FUNCTION_MIME } from './ContractsPanel';

const nodeTypes = { lisa: LisaNode };

/** Lets the sidebar place click-added nodes in the visible viewport. */
export interface CanvasApi {
  viewportCenter(): Vec2 | null;
  /** Flow-space rect of the currently visible canvas area. */
  viewportRect(): { x: number; y: number; width: number; height: number } | null;
}

export interface VisualCanvasProps {
  project: VisualProject;
  onMoveNodes(changes: Readonly<Record<string, Vec2>>, scopes?: Readonly<Record<string, ScopeTarget | null>>): void;
  onAddCallNode(contractId: string, signature: string, position: Vec2): void;
  onDeleteNodes(ids: string[]): void;
  onDeleteEdges(ids: string[]): void;
  onConnect(from: { node: string; port: string }, to: { node: string; port: string }): void;
  /** Inline edit commit from a node card; semantics stay in the project layer. */
  onPatchNode(id: string, fields: Record<string, unknown>): void;
  /** Committed IF frame resize; presentation metadata only. */
  onResizeIf?(id: string, size: IfFrameSize): void;
  /** Enable the ELSE branch of an IF block; semantic, one-way in this pass. */
  onEnableElse?(id: string): void;
  /** Click on a branch region: UI-only selection of the spawn target branch. */
  onSelectBranch?(nodeId: string, branch: 'then' | 'else'): void;
  /** UI-only spawn target: the branch region most recently selected. */
  selectedBranch?: { nodeId: string; branch: 'then' | 'else' } | null;
  onSelectNode(id: string | null): void;
  onSelectEdge(id: string | null): void;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  /** validateProject() findings; rendered on the nodes they belong to. */
  diagnostics?: readonly GraphDiagnostic[];
  /** Last added node; the view pans to keep new nodes discoverable. */
  focusNodeId?: string | null;
  /** Host handle for click-to-add placement in the visible viewport. */
  canvasApi?: React.MutableRefObject<CanvasApi | null>;
}

/**
 * Controlled projection of the semantic project. React Flow state is derived
 * on every render; only drops, drags, connections, deletes, and inline edits
 * flow back out.
 */
export function VisualCanvas(props: VisualCanvasProps) {
  return <ReactFlowProvider>
    <Canvas {...props} />
  </ReactFlowProvider>;
}

function Canvas({
  project, onMoveNodes, onAddCallNode, onDeleteNodes, onDeleteEdges, onConnect, onPatchNode, onResizeIf, onEnableElse, onSelectBranch, selectedBranch, onSelectNode, onSelectEdge, selectedNodeId, selectedEdgeId, diagnostics, focusNodeId, canvasApi,
}: VisualCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const hostRef = useRef<HTMLDivElement | null>(null);

  const ownApiRef = useRef<CanvasApi | null>(null);
  const apiRef = canvasApi ?? ownApiRef;
  useImperativeHandle(apiRef, () => ({
    viewportCenter: () => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    },
    viewportRect: () => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return null;
      const topLeft = screenToFlowPosition({ x: rect.left, y: rect.top });
      const bottomRight = screenToFlowPosition({ x: rect.right, y: rect.bottom });
      return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    },
  }), [screenToFlowPosition]);

  /*
   * The project is canonical and React Flow is a controlled projection, so
   * xyflow's internal selection-based delete (which needs onNodesChange to
   * round-trip changes) is disabled; deletion follows our own selection.
   * Focused form controls (inputs, selects) keep their keystrokes.
   */
  const deleteRef = useRef({ selectedNodeId, selectedEdgeId, onDeleteNodes, onDeleteEdges });
  deleteRef.current = { selectedNodeId, selectedEdgeId, onDeleteNodes, onDeleteEdges };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          || target instanceof HTMLSelectElement || target.isContentEditable)) return;
      const selection = deleteRef.current;
      if (selection.selectedNodeId) {
        event.preventDefault();
        selection.onDeleteNodes([selection.selectedNodeId]);
      } else if (selection.selectedEdgeId) {
        event.preventDefault();
        selection.onDeleteEdges([selection.selectedEdgeId]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const frames = useMemo(() => iframes(project), [project]);
  const errorsByNode = useMemo(() => indexDiagnostics(diagnostics ?? []), [diagnostics]);
  const nodes = useMemo<Node[]>(() => {
    // xyflow resolves parentId against earlier entries, so ancestors must be
    // projected before their children; creation order stays otherwise.
    const byId = new Map(project.nodes.map(n => [n.id, n] as const));
    const depthOf = (node: GraphNode): number => {
      let depth = 0;
      const seen = new Set<string>([node.id]);
      let parent = node.parent;
      while (parent !== undefined && !seen.has(parent)) {
        seen.add(parent);
        depth += 1;
        parent = byId.get(parent)?.parent;
      }
      return depth;
    };
    const ordered = project.nodes.map((node, index) => ({ node, index, depth: depthOf(node) }))
      .sort((a, b) => a.depth - b.depth || a.index - b.index);
    return ordered.map(({ node }) => {
      const position = project.positions[node.id] ?? { x: 0, y: 0 };
      const frame = frames.get(node.id);
      const data = {
        node, project, frame,
        errors: errorsByNode.get(node.id),
        selected: node.id === selectedNodeId,
        selectedBranch: selectedBranch?.nodeId === node.id ? selectedBranch.branch : undefined,
      };
      // Container frames live behind cards so they never swallow a drag that
      // starts on an overlapping node; children always outrank their frame.
      const zIndex = node.kind === 'if' ? 1 : 10;
      const parentOk = node.parent !== undefined && project.nodes.some(n => n.id === node.parent && n.kind === 'if');
      if (!parentOk || node.parent === undefined) {
        return {
          id: node.id, type: 'lisa', position, zIndex, selected: node.id === selectedNodeId,
          ...(frame ? { style: { width: frame.rect.width, height: frame.rect.height } } : {}),
          data,
        };
      }
      // React Flow nests transforms: children carry parent-relative positions.
      const parentAbs = absolutePosition(project, node.parent);
      return {
        id: node.id, type: 'lisa',
        parentId: node.parent,
        position: { x: position.x - parentAbs.x, y: position.y - parentAbs.y },
        zIndex,
        selected: node.id === selectedNodeId,
        ...(frame ? { style: { width: frame.rect.width, height: frame.rect.height } } : {}),
        data,
      };
    });
  }, [project, frames, errorsByNode, selectedNodeId, selectedBranch]);

  const edges = useMemo<Edge[]>(() => project.edges.map(edge => ({
    id: edge.id,
    source: edge.from.node,
    sourceHandle: edge.from.port,
    target: edge.to.node,
    targetHandle: edge.to.port,
  })), [project.edges]);

  const editApi = useMemo<NodeEditApi>(() => ({
    patch: onPatchNode,
    resize: onResizeIf,
    enableElse: onEnableElse,
    selectBranch: onSelectBranch,
  }), [onPatchNode, onResizeIf, onEnableElse, onSelectBranch]);

  const nodesRef = useRef(project.nodes);
  nodesRef.current = project.nodes;
  // xyflow's internal store mirrors the projected nodes (including parentId
  // nesting), which the drag callback must consult without re-binding.
  const rfNodesRef = useRef<Node[]>([]);
  rfNodesRef.current = nodes;
  useEffect(() => {
    if (focusNodeId && nodesRef.current.some(n => n.id === focusNodeId)) {
      void fitView({ nodes: [{ id: focusNodeId }], maxZoom: 1, duration: 250 });
    }
  }, [focusNodeId, fitView]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const payload = event.dataTransfer.getData(FUNCTION_MIME);
    if (!payload) return;
    try {
      const { contractId, signature } = JSON.parse(payload) as { contractId: string; signature: string };
      onAddCallNode(contractId, signature, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    } catch {
      // Malformed drags are ignored; the sidebar is the only producer.
    }
  }, [screenToFlowPosition, onAddCallNode]);

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    const source = project.nodes.find(n => n.id === connection.source);
    const target = project.nodes.find(n => n.id === connection.target);
    if (!source || !target || connection.source === connection.target) return false;
    const sourcePort = portsForNode(source, project).outputs.find(p => p.name === connection.sourceHandle);
    const targetPort = portsForNode(target, project).inputs.find(p => p.name === connection.targetHandle);
    return !!sourcePort && !!targetPort && canConnect(sourcePort, targetPort);
  }, [project]);

  /*
   * Drag end is where presentation meets semantics. Stored positions are
   * absolute; the drag event reports each directly dragged node in its own
   * projection space (parent-relative once React Flow nests a child), and
   * `group` holds only independently dragged nodes — RF children carried by
   * a dragged parent are added from the semantic subtree, each moving by
   * the ancestor's delta. A node whose center lands inside an IF body
   * enters that scope, leaving every body exits its old one. Pure moves
   * stay positional; only a changed containment is a semantic edit.
   */
  const onNodeDragStop = useCallback((_: MouseEvent | TouchEvent, node: Node, group?: Node[]) => {
    if (!project.nodes.some(n => n.id === node.id)) return;
    const saved = (id: string): Vec2 => project.positions[id] ?? { x: 0, y: 0 };
    // Every independently dragged card reports its post-drag position in
    // its own projection space (parent-relative once React Flow nests it);
    // normalizeDrag turns all of them into invariant-abiding positions and
    // semantic scope changes, carrying each node's children by delta.
    const desired: Record<string, Vec2> = {};
    for (const m of [...(group ?? []), node]) {
      const base = m.parentId === undefined ? { x: 0, y: 0 } : saved(m.parentId);
      desired[m.id] = { x: m.position.x + base.x, y: m.position.y + base.y };
    }
    const { changes, scopes } = normalizeDrag(project, desired);
    onMoveNodes(changes, scopes);
  }, [project, onMoveNodes]);

  return <div className="canvas-host" aria-label="Visual canvas" ref={hostRef}
    onDrop={onDrop} onDragOver={onDragOver}
  >
    <NodeEditContext.Provider value={editApi}>
      <ReactFlow
        colorMode="light"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={deleted => onDeleteNodes(deleted.map(node => node.id))}
        onEdgesDelete={deleted => onDeleteEdges(deleted.map(edge => edge.id))}
        onConnect={c => {
          if (c.source && c.target) {
            onConnect(
              { node: c.source, port: c.sourceHandle ?? 'out' },
              { node: c.target, port: c.targetHandle ?? 'in' },
            );
          }
        }}
        isValidConnection={isValidConnection}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => { onSelectNode(null); onSelectEdge(null); }}
      >
        <Background color={tokens.canvas.grid} gap={24} />
        <Controls showInteractive={false} />
        {project.nodes.length === 0 && (
          <Panel position="top-center">
            <div className="canvas-empty-hint">Drag a contract function here, or click one in the library.</div>
          </Panel>
        )}
      </ReactFlow>
    </NodeEditContext.Provider>
  </div>;
}
