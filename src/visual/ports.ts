import { isReadFunction, type GraphNode, type PortKind, type VisualProject } from './model';

/**
 * Port vocabulary derived from semantics + contract resources. Ports are
 * never persisted; they always come from this function, so ABI changes
 * immediately reshape node interfaces.
 */

export interface PortSpec {
  readonly name: string;
  readonly kind: PortKind;
  readonly label: string;
}

export function inputPorts(node: GraphNode, project: VisualProject): PortSpec[] {
  switch (node.kind) {
    case 'call': {
      const fn = findFunction(project, node.contractId, node.signature);
      const ports: PortSpec[] = (fn?.inputs ?? []).map((type, index) => ({
        name: `arg:${index}`,
        kind: type === 'address' ? 'address' : 'value',
        label: abiLabel(type, index),
      }));
      if (fn?.mutability === 'payable') {
        ports.push({ name: 'value', kind: 'value', label: 'value (wei)' });
      }
      return ports;
    }
    case 'binary':
      return [
        { name: 'lhs', kind: 'value', label: 'left' },
        { name: 'rhs', kind: 'value', label: 'right' },
      ];
    case 'return':
      return [{ name: 'result', kind: 'result', label: 'result' }];
    case 'if':
      return [{ name: 'condition', kind: 'condition', label: 'if' }];
    default:
      return [];
  }
}

export function outputPorts(node: GraphNode): PortSpec[] {
  switch (node.kind) {
    case 'call':
      return [{ name: 'result', kind: 'result', label: '→ result' }];
    case 'context':
      return [{ name: 'out', kind: node.name === 'SELF' || node.name === 'CALLER' ? 'address' : 'value', label: node.name }];
    case 'literal':
      return [{ name: 'out', kind: node.literalType === 'address' ? 'address' : 'value', label: 'value' }];
    case 'binary':
      return [{ name: 'out', kind: node.op === 'lt' || node.op === 'gt' || node.op === 'eq' ? 'condition' : 'value', label: 'value' }];
    case 'return':
      return [{ name: 'out', kind: 'value', label: 'value' }];
    case 'if':
      return [];
  }
}

export function findFunction(project: VisualProject, contractId: string, signature: string) {
  return project.contracts.find(c => c.id === contractId)?.functions.find(f => f.signature === signature);
}

export function isStaticCall(node: Extract<GraphNode, { kind: 'call' }>, project: VisualProject): boolean {
  const fn = findFunction(project, node.contractId, node.signature);
  return fn ? isReadFunction(fn) : false;
}

/**
 * Compatibility is deliberately coarse: words flow where words are expected,
 * addresses only feed address slots, and raw call results only feed decoders.
 */
export function canConnect(source: PortSpec, target: PortSpec): boolean {
  if (target.kind === 'result') return source.kind === 'result';
  if (target.kind === 'address') return source.kind === 'address';
  return source.kind !== 'result';
}

function abiLabel(type: string, index: number): string {
  return `${type} #${index + 1}`;
}
