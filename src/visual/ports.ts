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
        kind: type === 'address' ? 'address' : type === 'bool' ? 'bool' : 'value',
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
      return [{
        name: 'out',
        kind: node.literalType === 'address' ? 'address' : node.literalType === 'bool' ? 'bool' : 'value',
        label: 'value',
      }];
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
 * Compatibility mirrors what the builder can actually encode: word-valued
 * sources (values, conditions) and address outputs feed value slots,
 * addresses only feed address slots, booleans only exist as literals and fit
 * bool slots, and raw call results only feed decoders.
 */
export function canConnect(source: PortSpec, target: PortSpec): boolean {
  switch (target.kind) {
    case 'result': return source.kind === 'result';
    case 'address': return source.kind === 'address';
    case 'bool': return source.kind === 'bool' || source.kind === 'value';
    case 'condition': return source.kind === 'condition' || source.kind === 'value';
    case 'value': return source.kind === 'value' || source.kind === 'address' || source.kind === 'condition';
  }
}

function abiLabel(type: string, index: number): string {
  return `${type} #${index + 1}`;
}
