import { Handle, Position, type NodeProps } from '@xyflow/react';
import { inputPorts, outputPorts, type PortSpec } from './ports';
import type { GraphNode, VisualProject } from './model';

/** Canvas rendering of semantic nodes: labels + typed ports, no logic. */

export interface LisaNodeData extends Record<string, unknown> {
  kind: GraphNode['kind'];
  label: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
}

export function nodeLabel(node: GraphNode, project: VisualProject): string {
  switch (node.kind) {
    case 'call': {
      const contract = project.contracts.find(c => c.id === node.contractId);
      const fn = contract?.functions.find(f => f.signature === node.signature);
      const fnName = fn?.name ?? node.signature.split('(')[0];
      return `${contract?.name ?? `missing contract ${node.contractId}`} · ${fnName}`;
    }
    case 'context':
      return node.name;
    case 'literal':
      return node.literalType === 'address'
        ? `${node.literal.slice(0, 8)}…${node.literal.slice(-4)}`
        : node.literal;
    case 'binary':
      return ({ add: '+', sub: '−', mul: '×', div: '÷', lt: '<', gt: '>', eq: '=' })[node.op];
    case 'if':
      return 'IF';
  }
}

export function LisaNode({ data }: NodeProps) {
  const { kind, label, inputs, outputs } = data as unknown as LisaNodeData;
  return <div className={`lisa-node lisa-node-${kind}`}>
    {inputs.map((port, index) => <div className="port-row left" key={port.name} style={slot(index, inputs.length)}>
      <Handle type="target" id={port.name} position={Position.Left} className={`port port-${port.kind}`} title={`${port.label} (${port.kind})`} />
      <span className="port-label">{port.label}</span>
    </div>)}
    <div className="lisa-node-body">
      <span className="lisa-node-kind">{kind}</span>
      <span className="lisa-node-label">{label}</span>
    </div>
    {outputs.map((port, index) => <div className="port-row right" key={port.name} style={slot(index, outputs.length)}>
      <span className="port-label">{port.label}</span>
      <Handle type="source" id={port.name} position={Position.Right} className={`port port-${port.kind}`} title={`${port.label} (${port.kind})`} />
    </div>)}
  </div>;
}

function slot(index: number, count: number): React.CSSProperties {
  return { top: `${((index + 1) / (count + 1)) * 100}%` };
}

export function portsForNode(node: GraphNode, project: VisualProject) {
  return { inputs: inputPorts(node, project), outputs: outputPorts(node, project) };
}
