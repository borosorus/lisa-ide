import { type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { LisaNode, NodeEditContext } from './flowNodes';
import { emptyProject, type ContractFunction, type GraphNode, type VisualProject } from './model';

const ADDRESS = '0x1111111111111111111111111111111111111111';

function projectWith(functions: readonly ContractFunction[]): VisualProject {
  return { ...emptyProject(), contracts: [{ id: 'c1', name: 'Vault', address: ADDRESS, functions }] };
}

function renderNode(node: GraphNode, project: VisualProject, extra: Record<string, unknown> = {}, edit?: { patch: ReturnType<typeof vi.fn>; resize?: ReturnType<typeof vi.fn> }) {
  const patch = edit?.patch ?? vi.fn();
  const resize = edit?.resize ?? vi.fn();
  const { container } = render(<ReactFlowProvider>
    <NodeEditContext.Provider value={{ patch, resize }}>
      <LisaNode {...{ id: node.id, data: { node, project, ...extra } } as unknown as ComponentProps<typeof LisaNode>} />
    </NodeEditContext.Provider>
  </ReactFlowProvider>);
  return Object.assign(patch, { container, resize });
}

describe('LisaNode inline editing', () => {
  it('edits a literal value directly on the card', () => {
    const node: GraphNode = { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1000' };
    const patch = renderNode(node, emptyProject());
    const input = screen.getByLabelText('Literal value') as HTMLInputElement;
    expect(input.value).toBe('1000');
    fireEvent.change(input, { target: { value: '42' } });
    expect(patch).toHaveBeenCalledWith('lit1', { literal: '42' });
  });

  it('never commits invalid literal drafts', () => {
    const node: GraphNode = { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1000' };
    const patch = renderNode(node, emptyProject());
    fireEvent.change(screen.getByLabelText('Literal value'), { target: { value: '12x' } });
    fireEvent.change(screen.getByLabelText('Literal value'), { target: { value: '' } });
    expect(patch).not.toHaveBeenCalled();
  });

  it('switches literal type with a sensible default value', () => {
    const node: GraphNode = { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '7' };
    const patch = renderNode(node, emptyProject());
    fireEvent.change(screen.getByLabelText('Literal type'), { target: { value: 'bool' } });
    expect(patch).toHaveBeenCalledWith('lit1', { literalType: 'bool', literal: 'true' });
  });

  it('changes the operator in place', () => {
    const node: GraphNode = { id: 'op1', kind: 'binary', op: 'add' };
    const patch = renderNode(node, emptyProject());
    fireEvent.change(screen.getByLabelText('Operator'), { target: { value: 'gt' } });
    expect(patch).toHaveBeenCalledWith('op1', { op: 'gt' });
  });

  it('changes the context source in place', () => {
    const node: GraphNode = { id: 'ctx1', kind: 'context', name: 'SELF' };
    const patch = renderNode(node, emptyProject());
    fireEvent.change(screen.getByLabelText('Context value'), { target: { value: 'CALLER' } });
    expect(patch).toHaveBeenCalledWith('ctx1', { name: 'CALLER' });
  });

  it('keeps the Keccak output handle on the far edge of its row', () => {
    const { container } = renderNode({ id: 'hash1', kind: 'keccak', data: '0x01' }, emptyProject());
    const outputRow = container.querySelector('.lisa-node-keccak .node-row.control')!;

    expect(outputRow.querySelector('input[aria-label="Hash data"]')).not.toBeNull();
    const handle = outputRow.querySelector('[data-handleid="out"]');
    expect(handle).not.toBeNull();
    expect(handle!.className).toContain('source');
  });
});

describe('LisaNode call outputs', () => {
  it('switches a call to continue mode and shows its success port', () => {
    const project = projectWith([{
      signature: 'status()', name: 'status', inputs: [], outputs: ['uint256'], mutability: 'view',
    }]);
    const patch = renderNode({ id: 'call1', kind: 'call', contractId: 'c1', signature: 'status()', failureMode: 'continue' }, project);
    expect(patch.container.querySelector('[data-handleid="success"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revert on failure' }));
    expect(patch).toHaveBeenCalledWith('call1', { failureMode: 'revert' });
  });

  it('shows decodable and named outputs as ports', () => {
    const project = projectWith([{
      signature: 'balanceOf(address)', name: 'balanceOf', inputs: ['address'],
      outputs: ['uint256'], mutability: 'view', outputNames: ['balance'],
      inputNames: ['owner'],
    }]);
    renderNode({ id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' }, project);
    expect(screen.getByText('owner address')).toBeTruthy();
    expect(screen.getByText('uint256 balance')).toBeTruthy();
  });

  it('marks dynamic returns with a cross and a tooltip reason', () => {
    const project = projectWith([{
      signature: 'meta()', name: 'meta', inputs: [], outputs: ['string'], mutability: 'view',
    }]);
    renderNode({ id: 'call1', kind: 'call', contractId: 'c1', signature: 'meta()' }, project);
    expect(screen.getByText('✕ string #1')).toBeTruthy();
  });
});

describe('LisaNode interaction states', () => {
  const CALL: GraphNode = { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' };
  const fn: ContractFunction = {
    signature: 'balanceOf(address)', name: 'balanceOf', inputs: ['address'], outputs: ['uint256'], mutability: 'view',
  };
  const project = projectWith([fn]);

  it('marks an invalid node with an error outline and tooltip', () => {
    const { container } = renderNode(CALL, project, { errors: { messages: ['owner address is missing an input'], ports: new Set(['arg:0']) } });
    const card = container.querySelector('.lisa-node')!;
    expect(card.className).toContain('node-invalid');
    expect(card.getAttribute('title')).toContain('owner address is missing an input');
  });

  it('colors exactly the implicated port and row', () => {
    const { container } = renderNode(CALL, project, { errors: { messages: ['bad'], ports: new Set(['arg:0']) } });
    expect(container.querySelector('[data-handleid="arg\\:0"]')!.className).toContain('port-invalid');
    expect(container.querySelector('[data-handleid="arg\\:0"]')!.parentElement!.className).toContain('row-invalid');
    expect(container.querySelector('[data-handleid="out\\:0"]')!.className).not.toContain('port-invalid');
  });

  it('distinguishes selected, invalid, and selected-and-invalid', () => {
    const plain = renderNode(CALL, project, { selected: true });
    expect(plain.container.querySelector('.lisa-node')!.className).toBe('lisa-node lisa-node-call node-selected');
    const both = renderNode(CALL, project, { selected: true, errors: { messages: ['missing', 'and more'], ports: new Set<string>() } });
    const card = both.container.querySelector('.lisa-node')!;
    expect(card.className).toContain('node-selected');
    expect(card.className).toContain('node-invalid');
    expect(both.container.querySelector('.node-error-text')!.textContent).toBe('missing');
  });

  it('keeps unsupported ABI outputs visibly blocked even when the node errors', () => {
    const dyn: ContractFunction = {
      signature: 'get()', name: 'get', inputs: [], outputs: ['string[]'], mutability: 'view',
    };
    const { container } = renderNode(
      { id: 'call9', kind: 'call', contractId: 'c1', signature: 'get()' }, projectWith([dyn]),
      { errors: { messages: ['nope'], ports: new Set(['arg:7']) } },
    );
    const blocked = container.querySelector('[data-handleid="out\\:0"]')!;
    expect(blocked.className).toContain('port-blocked');
    expect(blocked.className).not.toContain('port-invalid');
    expect(blocked.parentElement!.textContent).toContain('✕');
  });

  it('renders a resize grip on IF frames and commits the dragged size once', () => {
    const edit = { patch: vi.fn(), resize: vi.fn() };
    const frame = { id: 'if1', rect: { x: 0, y: 0, width: 420, height: 260 }, header: { x: 0, y: 0, width: 420, height: 64 }, thenHeader: { x: 0, y: 64, width: 420, height: 28 }, thenBody: { x: 16, y: 92, width: 388, height: 152 }, depth: 0 };
    const { container } = renderNode({ id: 'if1', kind: 'if' }, emptyProject(), { frame }, edit);
    const grip = screen.getByLabelText('Resize container');
    expect(container.contains(grip)).toBe(true);
    fireEvent.pointerDown(grip, { clientX: 420, clientY: 260, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 500, clientY: 320, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: 500, clientY: 320, pointerId: 1 });
    expect(edit.resize).toHaveBeenCalledTimes(1);
    const size = edit.resize.mock.calls[0][1];
    expect(size.width).toBeGreaterThanOrEqual(420 + 80 - 1);
    expect(size.height).toBeGreaterThanOrEqual(260 + 60 - 1);
  });

  it('restores the stored frame size when a resize is cancelled', () => {
    const edit = { patch: vi.fn(), resize: vi.fn() };
    const frame = { id: 'if1', rect: { x: 0, y: 0, width: 420, height: 260 }, header: { x: 0, y: 0, width: 420, height: 64 }, thenHeader: { x: 0, y: 64, width: 420, height: 28 }, thenBody: { x: 16, y: 92, width: 388, height: 152 }, depth: 0 };
    renderNode({ id: 'if1', kind: 'if' }, emptyProject(), { frame }, edit);
    const grip = screen.getByLabelText('Resize container');
    fireEvent.pointerDown(grip, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 600, clientY: 600, pointerId: 1 });
    fireEvent.pointerCancel(grip, { pointerId: 1 });
    expect(edit.resize).not.toHaveBeenCalled();
  });

  it('never shrinks an IF below the minimum while dragging in', () => {
    const edit = { patch: vi.fn(), resize: vi.fn() };
    const frame = { id: 'if1', rect: { x: 0, y: 0, width: 260, height: 150 }, header: { x: 0, y: 0, width: 260, height: 64 }, thenHeader: { x: 0, y: 64, width: 260, height: 28 }, thenBody: { x: 16, y: 92, width: 228, height: 42 }, depth: 0 };
    renderNode({ id: 'if1', kind: 'if' }, emptyProject(), { frame }, edit);
    const grip = screen.getByLabelText('Resize container');
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: -400, clientY: -400, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: -400, clientY: -400, pointerId: 1 });
    expect(edit.resize.mock.calls[0][1]).toEqual({ width: 260, height: 150 });
  });
});

describe('balance, hash, and guard cards', () => {
  it('exposes an address input and a balance output on the balance card', () => {
    renderNode({ id: 'bal1', kind: 'balance' }, emptyProject());
    expect(screen.getByTitle('address (address)')).toBeInTheDocument();
    expect(screen.getByTitle('balance (out)')).toBeInTheDocument();
  });

  it('gives a guard its condition input and no output', () => {
    renderNode({ id: 'guard1', kind: 'guard' }, emptyProject());
    expect(screen.getByTitle('unless (condition)')).toBeInTheDocument();
    expect(screen.queryByTitle('balance (out)')).not.toBeInTheDocument();
  });

  it('commits hash data only when it is byte data', () => {
    const patch = renderNode({ id: 'hash1', kind: 'keccak', data: '0x00' }, emptyProject());
    const input = screen.getByLabelText('Hash data') as HTMLInputElement;
    expect(input.value).toBe('0x00');
    fireEvent.change(input, { target: { value: '0x0a1b' } });
    expect(patch).toHaveBeenCalledWith('hash1', { data: '0x0a1b' });
    fireEvent.change(input, { target: { value: '0x0a1' } });
    expect(patch).toHaveBeenCalledTimes(1);
  });
});

describe('send and raw call cards', () => {
  it('gives a send its two required inputs and no output', () => {
    renderNode({ id: 'send1', kind: 'send' }, emptyProject());
    expect(screen.getByTitle('address (address)')).toBeInTheDocument();
    expect(screen.getByTitle('value (wei) (value)')).toBeInTheDocument();
    expect(screen.queryByTitle('balance (out)')).not.toBeInTheDocument();
  });

  it('commits raw calldata only when it is byte data', () => {
    const patch = renderNode({ id: 'raw1', kind: 'rawcall', calldata: '0x' }, emptyProject());
    const input = screen.getByLabelText('Raw calldata') as HTMLInputElement;
    expect(input.value).toBe('0x');
    fireEvent.change(input, { target: { value: '0x12345678' } });
    expect(patch).toHaveBeenCalledWith('raw1', { calldata: '0x12345678' });
    fireEvent.change(input, { target: { value: '1234' } });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('marks the calldata field when validation flags it', () => {
    const { container } = renderNode(
      { id: 'raw1', kind: 'rawcall', calldata: '0x1' }, emptyProject(),
      { errors: { messages: ['Calldata "0x1" is not 0x-prefixed byte data'], ports: new Set(['calldata']) } },
    );
    expect(container.querySelector('.node-row.control.row-invalid')).not.toBeNull();
  });
});
