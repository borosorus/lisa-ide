import {
  canonicalWordType, isReadFunction, outputHeadOffsets,
  type GraphNode, type PortKind, type VisualProject,
} from './model';

/**
 * Port vocabulary derived from semantics + contract resources. Ports are
 * never persisted; they always come from this function, so ABI changes
 * immediately reshape node interfaces.
 */

export interface PortSpec {
  readonly name: string;
  readonly kind: PortKind;
  readonly label: string;
  /** False for outputs the lowering cannot decode (dynamic ABI types). */
  readonly connectable?: boolean;
  readonly reason?: string;
}

export function inputPorts(node: GraphNode, project: VisualProject): PortSpec[] {
  switch (node.kind) {
    case 'call': {
      const fn = findFunction(project, node.contractId, node.signature);
      const ports: PortSpec[] = (fn?.inputs ?? []).map((type, index) => ({
        name: `arg:${index}`,
        kind: type === 'address' ? 'address' : type === 'bool' ? 'bool' : 'value',
        label: paramLabel(fn?.inputNames?.[index], type, index),
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
    case 'balance':
      return [{ name: 'address', kind: 'address', label: 'address' }];
    case 'send':
    case 'rawcall':
      // Address and value; whether value is required differs at validation —
      // a Send with nothing to send is an error, a value-less raw call is a call.
      return [
        { name: 'address', kind: 'address', label: 'address' },
        { name: 'value', kind: 'value', label: 'value (wei)' },
      ];
    case 'guard':
      return [{ name: 'condition', kind: 'condition', label: 'unless' }];
    case 'if':
      return [{ name: 'condition', kind: 'condition', label: 'if' }];
    default:
      return [];
  }
}

export function outputPorts(node: GraphNode, project: VisualProject): PortSpec[] {
  switch (node.kind) {
    case 'call': {
      const fn = findFunction(project, node.contractId, node.signature);
      if (!fn) return [];
      const offsets = outputHeadOffsets(fn.outputs);
      return fn.outputs.map((type, index) => {
        const wordType = canonicalWordType(type);
        const decodable = wordType !== null && offsets[index] !== null;
        return {
          name: `out:${index}`,
          // Every decoded word lowers to a runtime Value; address-typed
          // outputs keep the address kind so they prefer address slots.
          kind: (decodable && type === 'address' ? 'address' : 'value') as PortKind,
          label: resultLabel(fn.outputNames?.[index], type, index),
          ...(decodable ? {} : {
            connectable: false,
            reason: wordType === null ? `${type} returns are not decodable yet` : 'output position cannot be located',
          }),
        };
      });
    }
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
    case 'balance':
      // A balance is an ordinary word: it is re-read wherever it is consumed.
      return [{ name: 'out', kind: 'value', label: 'balance' }];
    case 'keccak':
      return [{ name: 'out', kind: 'value', label: 'digest' }];
    // Statements: neither reaches for return data in v1 — no ABI means no
    // decodable shape, and a raw word would be an untyped read of nothing.
    case 'send':
    case 'rawcall':
      return [];
    case 'guard':
      return [];
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
 * sources (values, conditions, decoded words) and address outputs feed value
 * slots, addresses only feed address slots, booleans only exist as literal
 * booleans and fit bool slots, and decoded bools are ordinary values.
 */
export function canConnect(source: PortSpec, target: PortSpec): boolean {
  if (source.connectable === false || target.connectable === false) return false;
  switch (target.kind) {
    case 'address': return source.kind === 'address';
    case 'bool': return source.kind === 'bool' || source.kind === 'value';
    case 'condition': return source.kind === 'condition' || source.kind === 'value';
    case 'value': return source.kind === 'value' || source.kind === 'address' || source.kind === 'condition';
  }
}

/** ABI name when present, else type + position. */
function paramLabel(name: string | null | undefined, type: string, index: number): string {
  return name ? `${name} ${type}` : `${type} #${index + 1}`;
}

function resultLabel(name: string | null | undefined, type: string, index: number): string {
  return name ? `${type} ${name}` : `${type} #${index + 1}`;
}
