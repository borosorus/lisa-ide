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
});

describe('LisaNode call outputs', () => {
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
    expect(container.querySelector('.node-row')!.className).toContain('row-invalid');
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
    const frame = { id: 'if1', rect: { x: 0, y: 0, width: 420, height: 260 }, body: { x: 0, y: 44, width: 420, height: 216 }, thenBody: { x: 0, y: 44, width: 420, height: 216 }, depth: 0 };
    const { container } = renderNode({ id: 'if1', kind: 'if' }, emptyProject(), { frame }, edit);
    const grip = screen.getByLabelText('Resize IF frame');
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
    const frame = { id: 'if1', rect: { x: 0, y: 0, width: 420, height: 260 }, body: { x: 0, y: 44, width: 420, height: 216 }, thenBody: { x: 0, y: 44, width: 420, height: 216 }, depth: 0 };
    renderNode({ id: 'if1', kind: 'if' }, emptyProject(), { frame }, edit);
    const grip = screen.getByLabelText('Resize IF frame');
    fireEvent.pointerDown(grip, { clientX: 200, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 600, clientY: 600, pointerId: 1 });
    fireEvent.pointerCancel(grip, { pointerId: 1 });
    expect(edit.resize).not.toHaveBeenCalled();
  });

  it('never shrinks an IF below the minimum while dragging in', () => {
    const edit = { patch: vi.fn(), resize: vi.fn() };
    const frame = { id: 'if1', rect: { x: 0, y: 0, width: 260, height: 150 }, body: { x: 0, y: 44, width: 260, height: 106 }, thenBody: { x: 0, y: 44, width: 260, height: 106 }, depth: 0 };
    renderNode({ id: 'if1', kind: 'if' }, emptyProject(), { frame }, edit);
    const grip = screen.getByLabelText('Resize IF frame');
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: -400, clientY: -400, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: -400, clientY: -400, pointerId: 1 });
    expect(edit.resize.mock.calls[0][1]).toEqual({ width: 260, height: 150 });
  });
});
