import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { inputPorts, outputPorts, type PortSpec } from './ports';
import { BINARY_OPS, CONTEXT_NAMES, isValidLiteral, LITERAL_TYPES, type BinaryOp, type ContextName, type GraphNode, type LiteralType, type VisualProject } from './model';

/**
 * Canvas rendering of semantic nodes: readable cards with row-aligned ports
 * and inline controls for the few directly editable fields. Controls only
 * commit valid values; the semantic project stays outside React Flow.
 */

export interface NodeEditApi {
  /** Apply a validated field patch to the node with this id. */
  patch(nodeId: string, fields: Record<string, unknown>): void;
}

export const NodeEditContext = createContext<NodeEditApi | null>(null);

export interface LisaNodeData extends Record<string, unknown> {
  node: GraphNode;
  project: VisualProject;
}

/** Props every inline control needs so canvas gestures don't intercept it. */
function stopEvents(): React.HTMLAttributes<HTMLElement> {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return { onMouseDown: stop, onPointerDown: stop, onKeyDown: stop, onClick: e => e.stopPropagation() };
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

const OP_GLYPH: Record<BinaryOp, string> = { add: '+', sub: '−', mul: '×', div: '÷', lt: '<', gt: '>', eq: '=' };

export function LisaNode({ id, data }: NodeProps) {
  const { node, project } = data as unknown as LisaNodeData;
  const edit = useContext(NodeEditContext);
  const inputs = inputPorts(node, project);
  const outputs = outputPorts(node, project);

  // Handles moved between rows when the ABI or literal type changed; xyflow
  // only re-measures on request.
  const portSignature = [node.kind, ...inputs.map(p => `i${p.name}${p.kind}`), ...outputs.map(p => `o${p.name}${p.kind}${p.connectable === false ? 'x' : ''}`)].join('|');
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(id); }, [portSignature, id, updateInternals]);

  const stop = stopEvents();
  const title = node.kind === 'call' ? callTitle(node, project) : null;

  return <div className={`lisa-node lisa-node-${node.kind}`} title={nodeLabel(node, project)}>
    <div className="node-head">
      <span className="node-kind">{node.kind}</span>
      {title && <span className="node-name" title={title}>{title}</span>}
    </div>
    {inputs.map(port => <div className="node-row left" key={port.name}>
      <Handle type="target" id={port.name} position={Position.Left} className={`port port-${port.kind}`} title={`${port.label} (${port.kind})`} />
      <span className={`port-label${port.name === 'value' ? ' payable-value' : ''}`}>{port.label}</span>
    </div>)}
    {node.kind === 'context' && <div className="node-row control">
      <select className="nodrag node-select" value={node.name} aria-label="Context value" {...stop}
        onChange={e => edit?.patch(id, { name: e.target.value as ContextName })}>
        {CONTEXT_NAMES.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      <Handle type="source" id="out" position={Position.Right}
        className={`port ${node.name === 'SELF' || node.name === 'CALLER' ? 'port-address' : 'port-value'}`} title={`${node.name} (out)`} />
    </div>}
    {node.kind === 'literal' && <div className="node-row control">
      <select className="nodrag node-select" value={node.literalType} aria-label="Literal type" {...stop}
        onChange={e => {
          const literalType = e.target.value as LiteralType;
          edit?.patch(id, {
            literalType,
            literal: literalType === 'address' ? '0x0000000000000000000000000000000000000000' : literalType === 'bool' ? 'true' : '0',
          });
        }}>
        {LITERAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      {node.literalType === 'bool'
        ? <select className="nodrag node-select node-input" value={node.literal} aria-label="Literal value" {...stop}
            onChange={e => edit?.patch(id, { literal: e.target.value })}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        : <InlineLiteral id={id} type={node.literalType} value={node.literal} edit={edit} stop={stop} />}
      <Handle type="source" id="out" position={Position.Right}
        className={`port port-${node.literalType === 'address' ? 'address' : node.literalType === 'bool' ? 'bool' : 'value'}`} title="value (out)" />
    </div>}
    {node.kind === 'binary' && <>
      <div className="node-row left">
        <Handle type="target" id="lhs" position={Position.Left} className="port port-value" title="left (value)" />
        <span className="port-label">left</span>
      </div>
      <div className="node-row left">
        <Handle type="target" id="rhs" position={Position.Left} className="port port-value" title="right (value)" />
        <span className="port-label">right</span>
      </div>
      <div className="node-row control">
        <select className="nodrag node-select" value={node.op} aria-label="Operator" {...stop}
          onChange={e => edit?.patch(id, { op: e.target.value as BinaryOp })}>
          {BINARY_OPS.map(op => <option key={op} value={op}>{op} ({OP_GLYPH[op]})</option>)}
        </select>
        <Handle type="source" id="out" position={Position.Right}
          className={`port ${node.op === 'lt' || node.op === 'gt' || node.op === 'eq' ? 'port-condition' : 'port-value'}`} title="result (out)" />
      </div>
    </>}
    {node.kind === 'if' && <div className="node-row">
      <Handle type="target" id="condition" position={Position.Left} className="port port-condition" title="condition" />
      <span className="port-label">condition</span>
    </div>}
    {node.kind === 'call' && outputs.map(port => <div className="node-row right" key={port.name}>
      <span className={`port-label${port.connectable === false ? ' unsupported' : ''}`}
        title={port.connectable === false ? `${port.label}: ${port.reason}` : `${port.label} (${port.kind})`}>
        {port.connectable === false ? `✕ ${port.label}` : port.label}
      </span>
      <Handle type="source" id={port.name} position={Position.Right}
        className={`port port-${port.kind}${port.connectable === false ? ' port-blocked' : ''}`}
        title={port.connectable === false ? `${port.label}: ${port.reason}` : `${port.label} (${port.kind})`} />
    </div>)}
  </div>;
}

/** Free-text literal editor: commits only text the graph grammar accepts. */
function InlineLiteral({ id, type, value, edit, stop }: {
  id: string;
  type: Exclude<LiteralType, 'bool'>;
  value: string;
  edit: NodeEditApi | null;
  stop: React.HTMLAttributes<HTMLElement>;
}) {
  const [text, setText] = useState(value);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => { if (!drafting) setText(value); }, [value, drafting]);
  return <input
    className={`nodrag node-input${drafting && !isValidLiteral(type, text) ? ' invalid' : ''}`}
    value={text}
    aria-label="Literal value"
    spellCheck={false}
    {...stop}
    onFocus={() => setDrafting(true)}
    onChange={e => {
      setText(e.target.value);
      if (isValidLiteral(type, e.target.value)) edit?.patch(id, { literal: e.target.value });
    }}
    onBlur={() => {
      setDrafting(false);
      setText(value);
    }}
    onKeyDown={e => {
      (stop.onKeyDown as (ev: React.SyntheticEvent) => void)(e);
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
    }}
  />;
}

function callTitle(node: GraphNode, project: VisualProject): string | null {
  if (node.kind !== 'call') return null;
  const contract = project.contracts.find(c => c.id === node.contractId);
  const fn = contract?.functions.find(f => f.signature === node.signature);
  return fn ? `${contract?.name} · ${fn.signature}` : node.signature;
}

export function portsForNode(node: GraphNode, project: VisualProject) {
  return { inputs: inputPorts(node, project), outputs: outputPorts(node, project) };
}
