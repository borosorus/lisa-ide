import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Background, Controls, Panel, ReactFlow, ReactFlowProvider, useReactFlow,
  MarkerType, type Connection, type Edge, type Node,
} from '@xyflow/react';
import { Button, Stack, Tooltip, Typography } from '@mui/material';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import '@xyflow/react/dist/style.css';
import { LisaNode, NodeEditContext, nodeLabel, portsForNode, type NodeEditApi } from './flowNodes';
import { canConnect } from './ports';
import { absolutePosition, iframes, normalizeDrag } from './containment';
import { indexDiagnostics, type GraphDiagnostic } from './validate';
import { tokens } from '../theme/tokens';
import type { GraphNode, IfFrameSize, ScopeTarget, Vec2, VisualProject } from './model';
import { activeNodeIds, canPairElse, isContainer } from './controlFlow';
import { isStatementNode } from './model';
import { executionAfterIssue } from './executionOrder';
import { ExecutionOrderControl } from './ExecutionOrderControl';
import { FUNCTION_MIME } from './ContractsPanel';

const nodeTypes = { lisa: LisaNode };
const isExecutionOrderEdge = (edge: Pick<Edge, 'data'>) => edge.data?.lisaExecutionOrder === true;

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
  onSetFailureMode?(id: string, mode: 'revert' | 'continue'): string | undefined;
  /** Committed IF frame resize; presentation metadata only. */
  onResizeIf?(id: string, size: IfFrameSize): void;
  onSelectNode(id: string | null): void;
  onSelectEdge(id: string | null): void;
  onDuplicateSelected(): void;
  onSetExecutionAfter(id: string, predecessorId: string | null): void;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  /** validateProject() findings; rendered on the nodes they belong to. */
  diagnostics?: readonly GraphDiagnostic[];
  /** Node to reveal; nested nodes reveal their containing frame. */
  focusNodeId?: string | null;
  /** Monotonic token so selecting the same node repeatedly can reveal it again. */
  focusRequest?: number;
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
  project, onMoveNodes, onAddCallNode, onDeleteNodes, onDeleteEdges, onConnect, onPatchNode, onSetFailureMode, onResizeIf, onSelectNode, onSelectEdge, selectedNodeId, selectedEdgeId, onDuplicateSelected, onSetExecutionAfter, diagnostics, focusNodeId, focusRequest, canvasApi,
}: VisualCanvasProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [orderingSourceId, setOrderingSourceId] = useState<string | null>(null);
  const [orderingMessage, setOrderingMessage] = useState<string | null>(null);

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
   * Focused form controls and the node menu keep their keystrokes.
   */
  const deleteRef = useRef({ selectedNodeId, selectedEdgeId, onDeleteNodes, onDeleteEdges });
  deleteRef.current = { selectedNodeId, selectedEdgeId, onDeleteNodes, onDeleteEdges };
  const orderingSourceRef = useRef(orderingSourceId);
  orderingSourceRef.current = orderingSourceId;
  const cancelOrderingRef = useRef<() => void>(() => undefined);
  cancelOrderingRef.current = () => {
    setOrderingSourceId(null);
    setOrderingMessage(null);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && orderingSourceRef.current !== null) {
        event.preventDefault();
        cancelOrderingRef.current();
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          || target instanceof HTMLSelectElement || target.isContentEditable
          || target.closest('[data-node-menu]')) || document.querySelector('[data-node-menu]')) return;
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
  const active = useMemo(() => activeNodeIds(project), [project]);
  const orderIssues = useMemo(() => {
    if (orderingSourceId === null) return new Map<string, string>();
    return new Map(project.nodes.map(node => [
      node.id,
      executionAfterIssue(project, node.id, orderingSourceId, active),
    ] as const).filter((entry): entry is [string, string] => entry[1] !== null));
  }, [project, orderingSourceId, active]);
  useEffect(() => {
    if (orderingSourceId !== null && (selectedNodeId !== orderingSourceId || !active.has(orderingSourceId)
        || !project.nodes.some(node => node.id === orderingSourceId && isStatementNode(node)))) {
      setOrderingSourceId(null);
      setOrderingMessage(null);
    }
  }, [orderingSourceId, selectedNodeId, active, project.nodes]);
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
      const choosingSuccessor = orderingSourceId !== null && node.id !== orderingSourceId;
      const orderIssue = choosingSuccessor ? orderIssues.get(node.id) ?? null : null;
      const orderClass = orderingSourceId === null ? undefined
        : node.id === orderingSourceId ? 'execution-order-source'
          : orderIssue === null ? 'execution-order-candidate' : 'execution-order-blocked';
      const currentPredecessor = isStatementNode(node) ? node.executionAfter : undefined;
      const orderHint = node.id === orderingSourceId
        ? 'Choose a same-scope statement to run after this one.'
        : choosingSuccessor
          ? orderIssue ?? (currentPredecessor
            ? `Click to run after the selected statement. This replaces its current order after ${currentPredecessor}.`
            : 'Click to run after the selected statement.')
          : undefined;
      const data = {
        node, project, frame,
        errors: errorsByNode.get(node.id),
        selected: node.id === selectedNodeId,
        ...(orderingSourceId !== null ? { orderHint } : {}),
      };
      // Container frames live behind cards so they never swallow a drag that
      // starts on an overlapping node; children always outrank their frame.
      const zIndex = isContainer(node) ? 1 : 10;
      const parentOk = node.parent !== undefined && project.nodes.some(n => n.id === node.parent && isContainer(n));
      if (!parentOk || node.parent === undefined) {
        return {
          id: node.id, type: 'lisa', position, zIndex, selected: node.id === selectedNodeId,
          ...(orderClass ? { className: orderClass } : {}),
          draggable: orderingSourceId === null,
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
        ...(orderClass ? { className: orderClass } : {}),
        draggable: orderingSourceId === null,
        ...(frame ? { style: { width: frame.rect.width, height: frame.rect.height } } : {}),
        data,
      };
    });
  }, [project, frames, errorsByNode, selectedNodeId, orderingSourceId, orderIssues]);

  const edges = useMemo<Edge[]>(() => {
    const graphEdges: Edge[] = project.edges.map(edge => ({
      id: edge.id,
      source: edge.from.node,
      sourceHandle: edge.from.port,
      target: edge.to.node,
      targetHandle: edge.to.port,
      ...(edge.kind === 'control' ? { type: 'smoothstep', className: 'if-else-edge' } : {}),
    }));
    const byId = new Map(project.nodes.map(node => [node.id, node] as const));
    const usedEdgeIds = new Set(project.edges.map(edge => edge.id));
    const orderingEdges: Edge[] = project.nodes.flatMap(target => {
      if (!isStatementNode(target) || !target.executionAfter) return [];
      const predecessor = byId.get(target.executionAfter);
      if (!predecessor || !isStatementNode(predecessor) || !active.has(target.id) || !active.has(predecessor.id)) return [];
      if (target.id !== selectedNodeId && predecessor.id !== selectedNodeId
          && target.id !== orderingSourceId && predecessor.id !== orderingSourceId) return [];
      const baseId = `__lisa_execution_order__${target.id}`;
      let id = baseId;
      let suffix = 1;
      while (usedEdgeIds.has(id)) id = `${baseId}:${suffix++}`;
      usedEdgeIds.add(id);
      return [{
        id,
        data: { lisaExecutionOrder: true },
        source: predecessor.id,
        sourceHandle: 'execution-out',
        target: target.id,
        targetHandle: 'execution-in',
        type: 'smoothstep',
        className: 'execution-order-edge',
        markerEnd: { type: MarkerType.ArrowClosed, color: tokens.accent.secondary },
        selectable: false,
        deletable: false,
        reconnectable: false,
        focusable: false,
        interactionWidth: 0,
      } as Edge];
    });
    return [...graphEdges, ...orderingEdges];
  }, [project.edges, project.nodes, active, selectedNodeId, orderingSourceId]);

  const editApi = useMemo<NodeEditApi>(() => ({
    patch: onPatchNode,
    resize: onResizeIf,
    setFailureMode: onSetFailureMode,
  }), [onPatchNode, onResizeIf, onSetFailureMode]);

  const nodesRef = useRef(project.nodes);
  nodesRef.current = project.nodes;
  // xyflow's internal store mirrors the projected nodes (including parentId
  // nesting), which the drag callback must consult without re-binding.
  const rfNodesRef = useRef<Node[]>([]);
  rfNodesRef.current = nodes;
  useEffect(() => {
    if (focusNodeId) {
      const byId = new Map(nodesRef.current.map(node => [node.id, node] as const));
      let target = byId.get(focusNodeId);
      const seen = new Set<string>();
      while (target?.parent && !seen.has(target.id)) {
        seen.add(target.id);
        target = byId.get(target.parent) ?? target;
      }
      if (target) void fitView({ nodes: [{ id: target.id }], maxZoom: 1, duration: 250 });
    }
  }, [focusNodeId, focusRequest, fitView]);

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
    if (sourcePort?.kind === 'control' || targetPort?.kind === 'control') {
      return sourcePort?.kind === 'control' && targetPort?.kind === 'control' && canPairElse(project, source.id, target.id);
    }
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
        nodesConnectable={orderingSourceId === null}
        fitView
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={deleted => onDeleteNodes(deleted.map(node => node.id))}
        onEdgesDelete={deleted => onDeleteEdges(deleted.filter(edge => !isExecutionOrderEdge(edge)).map(edge => edge.id))}
        onConnect={c => {
          if (c.source && c.target) {
            onConnect(
              { node: c.source, port: c.sourceHandle ?? 'out' },
              { node: c.target, port: c.targetHandle ?? 'in' },
            );
          }
        }}
        isValidConnection={isValidConnection}
        onNodeClick={(_, node) => {
          if (orderingSourceId !== null) {
            if (node.id === orderingSourceId) {
              cancelOrderingRef.current();
              onSelectNode(orderingSourceId);
              return;
            }
            const issue = orderIssues.get(node.id) ?? null;
            if (issue) {
              setOrderingMessage(issue);
              return;
            }
            onSetExecutionAfter(node.id, orderingSourceId);
            setOrderingSourceId(null);
            setOrderingMessage(null);
            onSelectNode(orderingSourceId);
            onSelectEdge(null);
            return;
          }
          onSelectNode(node.id);
        }}
        onEdgeClick={(_, edge) => {
          if (isExecutionOrderEdge(edge)) return;
          if (orderingSourceId !== null) {
            setOrderingMessage('Choose a statement, or cancel ordering.');
            return;
          }
          onSelectEdge(edge.id);
        }}
        onPaneClick={() => {
          cancelOrderingRef.current();
          onSelectNode(null);
          onSelectEdge(null);
        }}
      >
        <Background color={tokens.canvas.grid} gap={24} />
        <Controls orientation="horizontal" showInteractive={false} />
        {selectedNodeId !== null && project.nodes.some(node => node.id === selectedNodeId) && (
          <Panel position="top-right" className="canvas-selection-actions">
            {project.nodes.some(node => node.id === selectedNodeId && isStatementNode(node)) &&
              <ExecutionOrderControl project={project} nodeId={selectedNodeId}
                isOrdering={orderingSourceId === selectedNodeId}
                onToggle={() => {
                  if (orderingSourceId === selectedNodeId) cancelOrderingRef.current();
                  else {
                    setOrderingSourceId(selectedNodeId);
                    setOrderingMessage(null);
                  }
                }}
                onClear={() => onSetExecutionAfter(selectedNodeId, null)} />}
            <Tooltip title="Duplicate selected node or IF block">
              <Button
                size="small"
                variant="outlined"
                startIcon={<ContentCopyRoundedIcon />}
                onClick={event => {
                  event.stopPropagation();
                  onDuplicateSelected();
                }}
              >
                Duplicate
              </Button>
            </Tooltip>
          </Panel>
        )}
        {orderingSourceId !== null && <Panel position="top-center" className="execution-order-instruction">
          <Stack direction="row" alignItems="center" gap={1}>
            <Typography variant="body2" role="status">
              {orderingMessage ?? `Choose a statement to run after ${project.nodes.find(node => node.id === orderingSourceId)
                ? `${nodeLabel(project.nodes.find(node => node.id === orderingSourceId)!, project)} (${orderingSourceId})` : 'this statement'}.`}
            </Typography>
            <Button size="small" onClick={event => {
              event.stopPropagation();
              cancelOrderingRef.current();
            }}>Cancel</Button>
          </Stack>
        </Panel>}
        {project.nodes.length === 0 && (
          <Panel position="top-center">
            <div className="canvas-empty-hint">Drag a contract function here, or click one in the library.</div>
          </Panel>
        )}
      </ReactFlow>
    </NodeEditContext.Provider>
  </div>;
}
