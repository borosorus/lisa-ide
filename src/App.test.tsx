import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { CompilerError } from './compile/client';
import { SOURCE_STORAGE_KEY } from './editor/sourceStorage';

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
    await waitFor(() => expect(localStorage.getItem(SOURCE_STORAGE_KEY)).toBe('changed'));
  });
});
