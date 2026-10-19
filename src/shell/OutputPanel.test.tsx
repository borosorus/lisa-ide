import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OutputPanel } from './OutputPanel';

describe('OutputPanel warnings', () => {
  it('shows advisory try-call warnings and offers navigation to the source line', () => {
    const reveal = vi.fn();
    render(<OutputPanel
      output={{ program: '0x00', programHash: '0xhash', byteSize: 1, instructionCount: 1, disassembly: ['STOP'],
        warnings: [{ message: 'Decode behind a success guard.', line: 4, column: 9 }] }}
      error={null} notice="" busy={false} imported={false} generated=""
      onCopy={() => undefined} onDownload={() => undefined} onErrorReveal={reveal}
    />);
    expect(screen.getByText('Line 4:9: Decode behind a success guard.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to line' }));
    expect(reveal).toHaveBeenCalledWith(4);
  });
});
