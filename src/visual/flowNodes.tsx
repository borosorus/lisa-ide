import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, useViewport, type NodeProps } from '@xyflow/react';
import { inputPorts, outputPorts, type PortSpec } from './ports';
import type { Frame } from './containment';
import { IF_MIN_SIZE, BINARY_OPS, CONTEXT_NAMES, isValidLiteral, LITERAL_TYPES, type BinaryOp, type ContextName, type GraphNode, type IfBranch, type IfFrameSize, type LiteralType, type VisualProject } from './model';
import { isBytesHex } from '../compile/hex';
import type { NodeErrors } from './validate';

/**
 * Canvas rendering of semantic nodes: readable cards with row-aligned ports
 * and inline controls for the few directly editable fields. Controls only
 * commit valid values; the semantic project stays outside React Flow.
 */

export interface NodeEditApi {
  /** Apply a validated field patch to the node with this id. */
  patch(nodeId: string, fields: Record<string, unknown>): void;
  /** Persist a user resize of an IF frame; presentation only. */
  resize?(nodeId: string, size: IfFrameSize): void;
  /** Give an IF block an ELSE branch; semantic, via projectState. */
  enableElse?(nodeId: string): void;
  /** UI-only: mark a branch region as the spawn target. */
  selectBranch?(nodeId: string, branch: 'then' | 'else'): void;
}

export const NodeEditContext = createContext<NodeEditApi | null>(null);

export interface LisaNodeData extends Record<string, unknown> {
  node: GraphNode;
  project: VisualProject;
  /** Presentation-only IF container frame; sized onto the node wrapper. */
  frame?: Frame;
  /** validateProject() findings for this node; canvas shows them in place. */
  errors?: NodeErrors;
  /** True for the currently selected node. */
  selected?: boolean;
  /** UI-only spawn target when this IF's region was last clicked. */
  selectedBranch?: IfBranch;
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
    case 'balance':
      return 'BALANCE';
    case 'keccak':
      return `KECCAK256(${node.data})`;
    case 'send':
      return 'SEND';
    case 'rawcall':
      return `RAW CALL(${node.calldata.length > 12 ? `${node.calldata.slice(0, 10)}…` : node.calldata})`;
    case 'guard':
      return 'REVERT UNLESS';
    case 'if':
      return 'IF';
  }
}

const OP_GLYPH: Record<BinaryOp, string> = { add: '+', sub: '−', mul: '×', div: '÷', lt: '<', gt: '>', eq: '=' };

export function LisaNode({ id, data }: NodeProps) {
  const { node, project, frame, errors, selected, selectedBranch } = data as unknown as LisaNodeData;
  const edit = useContext(NodeEditContext);
  const inputs = inputPorts(node, project);
  const outputs = outputPorts(node, project);
  const invalid = errors !== undefined && errors.messages.length > 0;
  const errorText = invalid ? errors.messages.join(' · ') : '';

  // Handles moved between rows when the ABI or literal type changed; xyflow
  // only re-measures on request.
  const portSignature = [node.kind, ...inputs.map(p => `i${p.name}${p.kind}`), ...outputs.map(p => `o${p.name}${p.kind}${p.connectable === false ? 'x' : ''}`)].join('|');
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(id); }, [portSignature, id, updateInternals]);

  const stop = stopEvents();
  const call = node.kind === 'call' ? callHead(node, project) : null;
  const bad = (port: string) => errors?.ports.has(port) === true;

  return <div className={`lisa-node lisa-node-${node.kind}${invalid ? ' node-invalid' : ''}${selected ? ' node-selected' : ''}`}
    title={`${nodeLabel(node, project)}${errorText ? ` — ${errorText}` : ''}`}>
    {call ? <>
      <div className="node-head"><span className="node-name" title={call.title}>{call.contract}</span></div>
      <div className="node-func" title={call.title}>{call.fn}</div>
    </> : <div className="node-head">
      <span className="node-kind">{node.kind}</span>
    </div>}
    {inputs.map(port => <div className={`node-row left${bad(port.name) ? ' row-invalid' : ''}`} key={port.name}>
      <Handle type="target" id={port.name} position={Position.Left}
        className={`port port-${port.kind}${bad(port.name) ? ' port-invalid' : ''}`}
        title={`${port.label} (${port.kind})${bad(port.name) ? ' — needs an input' : ''}`} />
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
        : <InlineField id={id} value={node.literal} ariaLabel="Literal value" edit={edit} stop={stop}
            isValid={text => isValidLiteral(node.literalType, text)} commit={literal => ({ literal })} />}
      <Handle type="source" id="out" position={Position.Right}
        className={`port port-${node.literalType === 'address' ? 'address' : node.literalType === 'bool' ? 'bool' : 'value'}`} title="value (out)" />
    </div>}
    {node.kind === 'binary' && <div className="node-row control">
      <select className="nodrag node-select" value={node.op} aria-label="Operator" {...stop}
        onChange={e => edit?.patch(id, { op: e.target.value as BinaryOp })}>
        {BINARY_OPS.map(op => <option key={op} value={op}>{op} ({OP_GLYPH[op]})</option>)}
      </select>
      <Handle type="source" id="out" position={Position.Right}
        className={`port ${node.op === 'lt' || node.op === 'gt' || node.op === 'eq' ? 'port-condition' : 'port-value'}`} title="result (out)" />
    </div>}
    {node.kind === 'balance' && <div className={`node-row right${bad('out') ? ' row-invalid' : ''}`}>
      <span className="port-label">balance</span>
      <Handle type="source" id="out" position={Position.Right}
        className={`port port-value${bad('out') ? ' port-invalid' : ''}`} title="balance (out)" />
    </div>}
    {node.kind === 'keccak' && <div className={`node-row control${bad('out') ? ' row-invalid' : ''}`}>
      <InlineField id={id} value={node.data} isValid={isBytesHex} commit={data => ({ data })}
        ariaLabel="Hash data" edit={edit} stop={stop} />
      <Handle type="source" id="out" position={Position.Right}
        className={`port port-value${bad('out') ? ' port-invalid' : ''}`} title="digest (out)" />
    </div>}
    {node.kind === 'rawcall' && <div className={`node-row control${bad('calldata') ? ' row-invalid' : ''}`}>
      <InlineField id={id} value={node.calldata} isValid={isBytesHex} commit={calldata => ({ calldata })}
        ariaLabel="Raw calldata" edit={edit} stop={stop} />
    </div>}
    {node.kind === 'call' && outputs.map(port => <div className={`node-row right${bad(port.name) ? ' row-invalid' : ''}`} key={port.name}>
      <span className={`port-label${port.connectable === false ? ' unsupported' : ''}`}
        title={port.connectable === false ? `${port.label}: ${port.reason}` : `${port.label} (${port.kind})`}>
        {port.connectable === false ? `✕ ${port.label}` : port.label}
      </span>
      <Handle type="source" id={port.name} position={Position.Right}
        className={`port port-${port.kind}${port.connectable === false ? ' port-blocked' : ''}${bad(port.name) ? ' port-invalid' : ''}`}
        title={port.connectable === false ? `${port.label}: ${port.reason}` : `${port.label} (${port.kind})`} />
    </div>)}
    {node.kind === 'if' && frame && <>
      <IfBranchRegions frame={frame} hasElse={node.kind === 'if' && node.hasElse === true} selectedBranch={selectedBranch} edit={edit} />
      <IfResizeGrip frame={frame} edit={edit} />
    </>}
    {selected && errors !== undefined && errors.messages.length > 0 && <div className="node-error-text" role="alert">{errors.messages[0]}</div>}
  </div>;
}

/**
 * THEN/ELSE work areas of an IF frame. The regions are a projection of the
 * frame geometry and carry no drop handling — containment is computed from
 * the semantic model on drop. Only the small affordances are interactive:
 * the branch labels pick the click-spawn target, and "+ ELSE" performs the
 * one semantic action on offer.
 */
function IfBranchRegions({ frame, hasElse, selectedBranch, edit }: {
  frame: Frame; hasElse: boolean; selectedBranch?: IfBranch; edit: NodeEditApi | null;
}) {
  const stop = stopEvents();
  const rel = (r: { x: number; y: number; width: number; height: number }) => ({
    left: r.x - frame.rect.x, top: r.y - frame.rect.y, width: r.width, height: r.height,
  });
  const chip = (branch: IfBranch, r: { x: number; y: number }) => (
    <button type="button"
      className={`if-branch-chip nodrag${selectedBranch === branch ? ' branch-selected' : ''}`}
      aria-label={`${branch === 'then' ? 'Then' : 'Else'} branch — click to spawn new nodes here`}
      {...stop}
      onClick={e => { (stop.onClick as (ev: React.MouseEvent) => void)(e); edit?.selectBranch?.(frame.id, branch); }}>
      {branch === 'then' ? 'THEN' : 'ELSE'}
    </button>
  );
  return <div className="if-regions">
    <div className="if-region" style={rel(frame.thenBody)} />
    <span className="if-chip-anchor" style={{ left: rel(frame.thenHeader).left + 8, top: rel(frame.thenHeader).top + 4 }}>{chip('then', frame.thenHeader)}</span>
    {hasElse && frame.elseBody && <>
      <div className="if-region if-region-else" style={rel(frame.elseBody)} />
      <span className="if-chip-anchor" style={{ left: rel(frame.elseHeader ?? frame.elseBody).left + 8, top: rel(frame.elseHeader ?? frame.elseBody).top + 4 }}>{chip('else', frame.elseHeader ?? frame.elseBody)}</span>
    </>}
    {!hasElse && (
      <button type="button" className="if-enable-else nodrag" title="Add an ELSE branch to this IF"
        {...stop}
        onClick={e => { (stop.onClick as (ev: React.MouseEvent) => void)(e); edit?.enableElse?.(frame.id); }}>
        + ELSE
      </button>
    )}
  </div>;
}

/**
 * Bottom-right resize grip for IF frames. Dragging is local: the live size
 * is written straight onto the node wrapper while the pointer is down, and
 * the final size is committed once to project presentation state on
 * release. Nothing semantic ever sees these numbers.
 */
function IfResizeGrip({ frame, edit }: { frame: Frame; edit: NodeEditApi | null }) {
  const { zoom } = useViewport();
  const drag = useRef<{
    element: HTMLElement | null;
    pointerX: number; pointerY: number; width: number; height: number; latest: IfFrameSize;
  } | null>(null);
  const gripRef = useRef<HTMLDivElement | null>(null);
  const stop = stopEvents();

  // A live-dragged (never committed) size must not survive cancel or unmount.
  useEffect(() => () => {
    const d = drag.current;
    if (d?.element) { d.element.style.width = `${d.width}px`; d.element.style.height = `${d.height}px`; }
  }, []);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    event.preventDefault();
    gripRef.current?.setPointerCapture?.(event.pointerId);
    drag.current = {
      element: gripRef.current?.closest('.react-flow__node') ?? null,
      pointerX: event.clientX, pointerY: event.clientY,
      width: frame.rect.width, height: frame.rect.height,
      latest: { width: frame.rect.width, height: frame.rect.height },
    };
  }
  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const size = {
      width: Math.max(IF_MIN_SIZE.width, d.width + (event.clientX - d.pointerX) / zoom),
      height: Math.max(IF_MIN_SIZE.height, d.height + (event.clientY - d.pointerY) / zoom),
    };
    d.latest = size;
    if (d.element) { d.element.style.width = `${size.width}px`; d.element.style.height = `${size.height}px`; }
  }
  function finish(event: React.PointerEvent<HTMLDivElement> | null, commit: boolean) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (event) gripRef.current?.releasePointerCapture?.(event.pointerId);
    if (commit) edit?.resize?.(frame.id, d.latest);
    else if (d.element) { d.element.style.width = `${d.width}px`; d.element.style.height = `${d.height}px`; }
  }

  return <div ref={gripRef} className="if-resize nodrag" aria-label="Resize IF frame" title="Drag to resize this IF"
    {...stop}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove}
    onPointerUp={event => finish(event, true)} onPointerCancel={() => finish(null, false)} />;
}

/** Free-text field on a card: commits only text the graph grammar accepts. */
function InlineField({ id, value, isValid, commit, ariaLabel, edit, stop }: {
  id: string;
  value: string;
  isValid: (text: string) => boolean;
  commit: (text: string) => Record<string, unknown>;
  ariaLabel: string;
  edit: NodeEditApi | null;
  stop: React.HTMLAttributes<HTMLElement>;
}) {
  const [text, setText] = useState(value);
  const [drafting, setDrafting] = useState(false);
  useEffect(() => { if (!drafting) setText(value); }, [value, drafting]);
  return <input
    className={`nodrag node-input${drafting && !isValid(text) ? ' invalid' : ''}`}
    value={text}
    aria-label={ariaLabel}
    spellCheck={false}
    {...stop}
    onFocus={() => setDrafting(true)}
    onChange={e => {
      setText(e.target.value);
      if (isValid(e.target.value)) edit?.patch(id, commit(e.target.value));
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

function callHead(node: GraphNode, project: VisualProject): { contract: string; fn: string; title: string } | null {
  if (node.kind !== 'call') return null;
  const contract = project.contracts.find(c => c.id === node.contractId);
  const fn = contract?.functions.find(f => f.signature === node.signature);
  if (!contract || !fn) return { contract: 'contract', fn: node.signature, title: node.signature };
  return { contract: contract.name, fn: fn.name, title: `${contract.name} · ${fn.signature}` };
}

export function portsForNode(node: GraphNode, project: VisualProject) {
  return { inputs: inputPorts(node, project), outputs: outputPorts(node, project) };
}
