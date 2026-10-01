import { useCallback, useMemo } from 'react';
import {
  Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { LisaNode, nodeLabel, portsForNode } from './flowNodes';
import { canConnect } from './ports';
import type { Vec2, VisualProject } from './model';
import { FUNCTION_MIME } from './ContractsPanel';

const nodeTypes = { lisa: LisaNode };

export interface VisualCanvasProps {
  project: VisualProject;
  onMoveNodes(changes: Readonly<Record<string, Vec2>>): void;
  onAddCallNode(contractId: string, signature: string, position: Vec2): void;
  onDeleteNodes(ids: string[]): void;
  onDeleteEdges(ids: string[]): void;
  onConnect(from: { node: string; port: string }, to: { node: string; port: string }): void;
  onSelectNode(id: string | null): void;
}

/**
 * Controlled projection of the semantic project. React Flow state is derived
 * on every render; only drops, drags, connections, and deletes flow back out.
 */
export function VisualCanvas(props: VisualCanvasProps) {
  return <ReactFlowProvider>
    <Canvas {...props} />
  </ReactFlowProvider>;
}

function Canvas({
  project, onMoveNodes, onAddCallNode, onDeleteNodes, onDeleteEdges, onConnect, onSelectNode,
}: VisualCanvasProps) {
  const { screenToFlowPosition } = useReactFlow();

  const nodes = useMemo<Node[]>(() => project.nodes.map(node => {
    const ports = portsForNode(node, project);
    return {
      id: node.id,
      type: 'lisa',
      position: project.positions[node.id] ?? { x: 0, y: 0 },
      data: { kind: node.kind, label: nodeLabel(node, project), inputs: ports.inputs, outputs: ports.outputs },
    };
  }), [project]);

  const edges = useMemo<Edge[]>(() => project.edges.map(edge => ({
    id: edge.id,
    source: edge.from.node,
    sourceHandle: edge.from.port,
    target: edge.to.node,
    targetHandle: edge.to.port,
  })), [project.edges]);

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

  return <div className="canvas-host" aria-label="Visual canvas"
    onDrop={onDrop} onDragOver={onDragOver}
  >
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      deleteKeyCode={['Backspace', 'Delete']}
      proOptions={{ hideAttribution: true }}
      onNodeDragStop={(_, node) => onMoveNodes({ [node.id]: node.position })}
      onNodesDelete={ids => onDeleteNodes(ids.filter(id => typeof id === 'string'))}
      onEdgesDelete={ids => onDeleteEdges(ids.filter(id => typeof id === 'string'))}
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
      onPaneClick={() => onSelectNode(null)}
    >
      <Background color="#26354c" gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
