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

function renderNode(node: GraphNode, project: VisualProject) {
  const patch = vi.fn();
  render(<ReactFlowProvider>
    <NodeEditContext.Provider value={{ patch }}>
      <LisaNode {...{ id: node.id, data: { node, project } } as unknown as ComponentProps<typeof LisaNode>} />
    </NodeEditContext.Provider>
  </ReactFlowProvider>);
  return patch;
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
