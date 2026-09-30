import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const compileMock = vi.fn();
const cancelMock = vi.fn();
vi.mock('./compile/client', () => ({
  CompilerClient: class {
    compile = compileMock;
    cancel = cancelMock;
  },
}));
vi.mock('./editor/SourceEditor', () => ({
  SourceEditor: ({ onChange }: { onChange: (value: string) => void }) =>
    <textarea aria-label="LISA source editor" onChange={event => onChange(event.target.value)} />,
}));

const output = {
  program: '0x00', programHash: '0xhash', byteSize: 1,
  instructionCount: 1, disassembly: ['STOP'],
};

describe('App', () => {
  beforeEach(() => { compileMock.mockReset(); cancelMock.mockReset(); });
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

  it('clears stale output after editing', async () => {
    compileMock.mockResolvedValue(output);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
    await screen.findByLabelText('Compiled bytecode');
    fireEvent.change(screen.getByLabelText('LISA source editor'), { target: { value: 'changed' } });
    expect(screen.queryByLabelText('Compiled bytecode')).not.toBeInTheDocument();
  });
});
