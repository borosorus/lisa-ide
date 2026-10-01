import type { NodeProps } from '@xyflow/react';
import type { GraphNode, VisualProject } from './model';

/** Canvas rendering of semantic nodes: labels only, logic lives in the model. */

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
    case 'return':
      return node.decoder === 'word' ? `word(${node.offset ?? 0})` : `${node.decoder}()`;
    case 'if':
      return 'IF';
  }
}

export function LisaNode({ data }: NodeProps) {
  return <div className="lisa-node">
    <span className="lisa-node-kind">{String(data.kind)}</span>
    <span className="lisa-node-label">{String(data.label)}</span>
  </div>;
}
