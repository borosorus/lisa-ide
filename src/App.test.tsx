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
  VisualCanvas: (props: {
    project: { contracts: { id: string }[] };
    onAddCallNode: (contractId: string, signature: string, position: { x: number; y: number }) => void;
  }) => <>
    <div aria-label="Visual canvas" />
    <button
      aria-label="simulate-drop"
      onClick={() => props.onAddCallNode(props.project.contracts[0]?.id ?? 'missing', 'balanceOf(address)', { x: 10, y: 20 })}
    />
  </>,
}));

const output = {
  program: '0x00', programHash: '0xhash', byteSize: 1,
  instructionCount: 1, disassembly: ['STOP'],
};

describe('App', () => {
  beforeEach(() => {
    compileMock.mockReset();
    inspectMock.mockReset();
    cancelMock.mockReset();
    localStorage.clear();
  });
  afterEach(() => vi.unstubAllGlobals());

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
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    expect(await screen.findByLabelText('Visual canvas')).toBeInTheDocument();
    expect(screen.queryByLabelText('LISA source editor')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(screen.getByLabelText('LISA source editor')).toBeInTheDocument();
    expect(screen.queryByLabelText('Visual canvas')).not.toBeInTheDocument();
  });

  it('adds a contract from the sidebar and creates a call node from a dropped function', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '0x1111111111111111111111111111111111111111' } });
    fireEvent.change(screen.getByLabelText('ABI JSON'), { target: { value: JSON.stringify([
      { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    ]) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contract' }));
    expect(await screen.findByText('balanceOf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'simulate-drop' }));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) ?? '{}');
      expect(saved.visual.contracts[0]).toMatchObject({ id: 'c1', name: 'USDC' });
      expect(saved.visual.nodes).toEqual([
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      ]);
    });
  });

  it('rejects an invalid contract address in the sidebar', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '0x123' } });
    fireEvent.change(screen.getByLabelText('ABI JSON'), { target: { value: '[{"type":"function","name":"f","inputs":[],"outputs":[]}]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contract' }));
    expect(await screen.findByText(/20-byte hex/)).toBeInTheDocument();
    expect(screen.getByText('No contracts yet. Add one to drag its functions onto the canvas.')).toBeInTheDocument();
  });

  it('compiles the visual graph and exposes read-only generated source', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await screen.findByLabelText('Compiled bytecode');
    fireEvent.click(screen.getByRole('tab', { name: 'Generated source' }));
    expect(screen.getByLabelText('Generated source')).toHaveTextContent('createProgram');
    expect(compileMock).toHaveBeenCalledWith(expect.stringContaining('createProgram'));
  });

  it('shows graph-level errors without invoking the Worker', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'USDC' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '0x1111111111111111111111111111111111111111' } });
    fireEvent.change(screen.getByLabelText('ABI JSON'), { target: { value: JSON.stringify([
      { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
    ]) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contract' }));
    await screen.findByText('balanceOf');
    fireEvent.click(screen.getByRole('button', { name: 'simulate-drop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    expect(await screen.findByText(/is missing an input/)).toBeInTheDocument();
    expect(compileMock).not.toHaveBeenCalled();
  });
});
