import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { CompilerError } from './compile/client';
import { PROJECT_STORAGE_KEY } from './visual/storage';

const { compileMock, inspectMock, cancelMock } = vi.hoisted(() => ({
  compileMock: vi.fn(),
  inspectMock: vi.fn(),
  cancelMock: vi.fn(),
}));

vi.mock('./compile/client', () => {
  class CompilerError extends Error {
    constructor(readonly diagnostic: { message: string; line?: number; column?: number }) {
      super(diagnostic.message);
      this.name = 'CompilerError';
    }
  }
  return {
    CompilerError,
    CompilerClient: class {
      compile = compileMock;
      inspect = inspectMock;
      cancel = cancelMock;
    },
  };
});
vi.mock('./editor/SourceEditor', () => ({
  SourceEditor: ({ onChange, diagnostic }: {
    onChange: (value: string) => void;
    diagnostic?: { message: string; line?: number; column?: number } | null;
  }) => <>
    <textarea aria-label="LISA source editor" onChange={event => onChange(event.target.value)} />
    {diagnostic?.line && <span data-testid="editor-diagnostic">{diagnostic.line}:{diagnostic.column}</span>}
  </>,
}));
vi.mock('./visual/VisualCanvas', () => ({
  VisualCanvas: (props: Record<string, any>) => <>
    <div aria-label="Visual canvas" />
    {/* Context cards inline-edit their value; the test drives that control. */}
    {props.project.nodes.filter((n: { kind: string }) => n.kind === 'context').map((n: { id: string; name: string }) =>
      <select key={n.id} aria-label="Context value" value={n.name}
        onChange={e => props.onPatchNode(n.id, { name: e.target.value })}>
        <option value="SELF">SELF</option>
        <option value="CALLER">CALLER</option>
      </select>)}
    <button
      aria-label="simulate-drop"
      onClick={() => props.onAddCallNode(props.project.contracts[0]?.id ?? 'missing', 'balanceOf(address)', { x: 10, y: 20 })}
    />
    <button aria-label="simulate-select-first" onClick={() => props.onSelectNode(props.project.nodes[0]?.id ?? null)} />
    <button
      aria-label="simulate-connect"
      onClick={() => props.onConnect({ node: 'lit1', port: 'out' }, { node: 'call1', port: 'arg:0' })}
    />
    <button
      aria-label="simulate-connect-ctx"
      onClick={() => props.onConnect({ node: 'ctx1', port: 'out' }, { node: 'call1', port: 'arg:0' })}
    />
    <button
      aria-label="simulate-delete-first"
      onClick={() => props.onDeleteNodes(props.project.nodes.slice(0, 1).map((n: { id: string }) => n.id))}
    />
  </>,
}));

const output = {
  program: '0x00', programHash: '0xhash', byteSize: 1,
  instructionCount: 1, disassembly: ['STOP'],
};

const ADDRESS = '0x1111111111111111111111111111111111111111';
const BALANCE_ABI = JSON.stringify([
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]);

describe('App', () => {
  beforeEach(() => {
    compileMock.mockReset();
    inspectMock.mockReset();
    cancelMock.mockReset();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

  function toVisual() {
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
  }

  /** Visual mode collapses Output by default; content assertions expand it. */
  function openOutput() {
    const toggle = screen.getByRole('button', { name: /Output/, expanded: false });
    fireEvent.click(toggle);
  }

  /** Add a contract through the dialog and wait for its collapsed row. */
  async function addContract(name = 'USDC', abi = BALANCE_ABI, address = ADDRESS) {
    fireEvent.click(screen.getByRole('button', { name: '+ Add contract' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: address } });
    fireEvent.change(screen.getByLabelText('ABI JSON'), { target: { value: abi } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await screen.findByRole('button', { name: `Expand ${name}` });
  }

  async function expandContract(name: string) {
    fireEvent.click(screen.getByRole('button', { name: `Expand ${name}` }));
  }

  it('compiles source and shows bytecode and disassembly', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await screen.findByLabelText('Compiled bytecode');
    expect(screen.getByText('1 bytes')).toBeInTheDocument();
    expect(screen.getByLabelText('Compiled bytecode')).toHaveTextContent('0x00');
    fireEvent.click(screen.getByRole('tab', { name: 'Disassembly' }));
    expect(screen.getByLabelText('Disassembly')).toHaveTextContent('STOP');
  });

  it('shows structured source diagnostics', async () => {
    compileMock.mockRejectedValue(new CompilerError({ message: 'Unknown name: NOPE', line: 2, column: 5 }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText('Line 2:5: Unknown name: NOPE')).toBeInTheDocument();
    expect(screen.getByTestId('editor-diagnostic')).toHaveTextContent('2:5');
  });

  it('copies bytecode and exports a JSON artifact', async () => {
    compileMock.mockResolvedValue(output);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const createObjectURL = vi.fn().mockReturnValue('blob:test');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await screen.findByLabelText('Compiled bytecode');
    fireEvent.click(screen.getByRole('button', { name: 'Copy bytecode' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('0x00'));
    fireEvent.click(screen.getByRole('button', { name: 'Export artifact' }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it('clears stale output and persists source after editing', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await screen.findByLabelText('Compiled bytecode');
    fireEvent.change(screen.getByLabelText('LISA source editor'), { target: { value: 'changed' } });
    expect(screen.queryByLabelText('Compiled bytecode')).not.toBeInTheDocument();
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.codeSource).toBe('changed');
    });
  });

  it('switches between code and visual authoring modes', async () => {
    render(<App />);
    expect(screen.getByLabelText('LISA source editor')).toBeInTheDocument();
    toVisual();
    expect(await screen.findByLabelText('Visual canvas')).toBeInTheDocument();
    expect(screen.queryByLabelText('LISA source editor')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(screen.getByLabelText('LISA source editor')).toBeInTheDocument();
    expect(screen.queryByLabelText('Visual canvas')).not.toBeInTheDocument();
  });

  it('adds a contract from the library dialog and creates a call node from a dropped function', async () => {
    render(<App />);
    toVisual();
    await addContract();
    fireEvent.click(screen.getByRole('button', { name: 'simulate-drop' }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.contracts[0]).toMatchObject({ id: 'c1', name: 'USDC' });
      expect(saved.visual.nodes).toEqual([
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      ]);
    });
  });

  it('keeps the add-contract dialog contained and rejects an invalid address', async () => {
    render(<App />);
    toVisual();
    fireEvent.click(screen.getByRole('button', { name: '+ Add contract' }));
    // The form only exists inside the dialog, not permanently in the panel.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '0x123' } });
    fireEvent.change(screen.getByLabelText('ABI JSON'), { target: { value: '[{"type":"function","name":"f","inputs":[],"outputs":[]}]' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    expect(await screen.findByText(/20-byte hex/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('No contracts yet. Add one to place its functions on the canvas.')).toBeInTheDocument();
  });

  it('starts contracts collapsed and reveals searchable functions on expand', async () => {
    render(<App />);
    toVisual();
    const abi = JSON.stringify([
      { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
      { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
    ]);
    await addContract('USDC', abi);
    // Rows carry the canonical signature, so overloads read differently.
    expect(screen.queryByText('balanceOf(address)')).not.toBeInTheDocument();
    await expandContract('USDC');
    expect(await screen.findByText('balanceOf(address)')).toBeInTheDocument();
    expect(screen.getByText('transfer(address,uint256)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search functions in USDC'), { target: { value: 'uint256)' } });
    expect(screen.queryByText('balanceOf(address)')).not.toBeInTheDocument();
    expect(screen.getByText('transfer(address,uint256)')).toBeInTheDocument();
  });

  it('shows overloads as distinct rows', async () => {
    render(<App />);
    toVisual();
    await addContract('Vault', JSON.stringify([
      { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
      { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
    ]));
    await expandContract('Vault');
    expect(await screen.findByRole('button', { name: 'transfer(address)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'transfer(address,uint256)' })).toBeInTheDocument();
  });

  it('adds a call node by clicking a function in the library', async () => {
    render(<App />);
    toVisual();
    await addContract();
    await expandContract('USDC');
    fireEvent.click(screen.getByRole('button', { name: 'balanceOf(address)' }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.nodes).toEqual([
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      ]);
    });
  });

  it('places repeated click-added nodes at separated positions', async () => {
    render(<App />);
    toVisual();
    await addContract();
    await expandContract('USDC');
    for (let i = 1; i <= 3; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'balanceOf(address)' }));
      await waitFor(() => expect(JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}').visual.nodes).toHaveLength(i));
    }
    const positions = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}').visual.positions;
    const seen = new Set(Object.values(positions as Record<string, { x: number; y: number }>).map(p => `${p.x},${p.y}`));
    expect(seen.size).toBe(3);
  });

  it('compiles the visual graph and exposes read-only generated source', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    toVisual();
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    openOutput();
    await screen.findByLabelText('Compiled bytecode');
    fireEvent.click(screen.getByRole('tab', { name: 'Generated source' }));
    expect(screen.getByLabelText('Generated source')).toHaveTextContent('createProgram');
    expect(compileMock).toHaveBeenCalledWith(expect.stringContaining('createProgram'));
  });

  it('shows graph-level errors without invoking the Worker', async () => {
    render(<App />);
    toVisual();
    await addContract();
    fireEvent.click(screen.getByRole('button', { name: 'simulate-drop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText(/is missing an input/)).toBeInTheDocument();
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('creates nodes from the palette and edits the selected node', async () => {
    render(<App />);
    toVisual();
    fireEvent.click(screen.getByRole('tab', { name: 'Nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Context' }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.nodes).toEqual([{ id: 'ctx1', kind: 'context', name: 'SELF' }]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'simulate-select-first' }));
    fireEvent.change(screen.getByLabelText('Context value'), { target: { value: 'CALLER' } });
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.nodes[0].name).toBe('CALLER');
    });
  });

  it('collapses the library to widen the canvas', async () => {
    render(<App />);
    toVisual();
    expect(screen.getByRole('button', { name: '+ Add contract' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse library' }));
    expect(screen.queryByRole('button', { name: '+ Add contract' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand library' }));
    expect(screen.getByRole('button', { name: '+ Add contract' })).toBeInTheDocument();
  });

  it('connects ports through the canvas', async () => {
    render(<App />);
    toVisual();
    await addContract();
    fireEvent.click(screen.getByRole('tab', { name: 'Nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Literal' }));
    fireEvent.click(screen.getByRole('button', { name: 'simulate-drop' }));
    fireEvent.click(screen.getByRole('button', { name: 'simulate-connect' }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.edges).toEqual([
        { id: 'e1', from: { node: 'lit1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      ]);
    });
  });

  it('deletes nodes from the canvas with their edges', async () => {
    render(<App />);
    toVisual();
    await addContract();
    fireEvent.click(screen.getByRole('tab', { name: 'Nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Literal' }));
    fireEvent.click(screen.getByRole('button', { name: 'simulate-drop' }));
    fireEvent.click(screen.getByRole('button', { name: 'simulate-connect' }));
    await waitFor(() => expect((JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}').visual.edges)).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'simulate-delete-first' }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.nodes).toEqual([{ id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' }]);
      expect(saved.visual.edges).toEqual([]);
    });
  });

  it('collapses the output panel to a one-line summary', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    toVisual();
    expect(screen.getByRole('button', { name: /Output/, expanded: false })).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await waitFor(() => expect(screen.getByText('✓ compiled · 1 bytes')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Output/ }));
    expect(await screen.findByLabelText('Compiled bytecode')).toBeInTheDocument();
  });

  it('invalidates compiled output when switching authoring modes', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await screen.findByLabelText('Compiled bytecode');
    toVisual();
    expect(screen.queryByLabelText('Compiled bytecode')).not.toBeInTheDocument();
  });

  it('starts visual mode with the output collapsed', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      version: 1, mode: 'visual', codeSource: null, visual: { nodes: [], edges: [], contracts: [], positions: {} },
    }));
    render(<App />);
    expect(screen.getByLabelText('Visual canvas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Output/, expanded: false })).toBeInTheDocument();
    expect(screen.queryByLabelText('Compiled bytecode')).not.toBeInTheDocument();
  });

  it('edits a contract address in place and updates every reference', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    toVisual();
    await addContract();
    await expandContract('USDC');
    fireEvent.click(screen.getByRole('tab', { name: 'Nodes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Context' }));
    fireEvent.click(screen.getByRole('button', { name: 'simulate-drop' }));
    fireEvent.click(screen.getByRole('button', { name: 'simulate-connect-ctx' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Contracts' }));
    await expandContract('USDC');
    fireEvent.change(screen.getByLabelText('Address for USDC'), { target: { value: '0x2222222222222222222222222222222222222222' } });
    fireEvent.blur(screen.getByLabelText('Address for USDC'));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.contracts[0].address).toBe('0x2222222222222222222222222222222222222222');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    openOutput();
    await screen.findByLabelText('Compiled bytecode');
    fireEvent.click(screen.getByRole('tab', { name: 'Generated source' }));
    expect(screen.getByLabelText('Generated source')).toHaveTextContent('0x2222222222222222222222222222222222222222');
  });

  it('keeps the stored address when an inline address edit is invalid', async () => {
    render(<App />);
    toVisual();
    await addContract();
    await expandContract('USDC');
    fireEvent.change(screen.getByLabelText('Address for USDC'), { target: { value: '0xnope' } });
    fireEvent.blur(screen.getByLabelText('Address for USDC'));
    expect(await screen.findByText(/20-byte hex/)).toBeInTheDocument();
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.contracts[0].address).toBe(ADDRESS);
    });
    expect(screen.getByLabelText<HTMLInputElement>('Address for USDC').value).toBe(ADDRESS);
  });

  it('restores a saved visual project on load', () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      version: 1, mode: 'visual', codeSource: null,
      visual: {
        contracts: [], nodes: [{ id: 'ctx1', kind: 'context', name: 'SELF' }], edges: [],
        positions: { ctx1: { x: 1, y: 2 } },
      },
    }));
    render(<App />);
    expect(screen.getByLabelText('Visual canvas')).toBeInTheDocument();
    expect(screen.queryByLabelText('LISA source editor')).not.toBeInTheDocument();
  });

  it('recovers gracefully from a corrupt saved project', () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, '{"version":1,"visual":"broken');
    render(<App />);
    expect(screen.getByLabelText('LISA source editor')).toBeInTheDocument();
  });
});
