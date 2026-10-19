import { useState, type ReactNode } from 'react';
import { Alert, Box, Button, Chip, Stack, Tab, Tabs, Typography } from '@mui/material';
import type { CompileDiagnostic, CompileOutput } from '../compile/types';

/**
 * The program view: everything the compiled artifact says about itself, plus
 * the actions that belong to the artifact it is showing. `actions` is where
 * execution places itself when its pane is open — the action follows the
 * object it acts on.
 */
export function OutputPanel(props: {
  output: CompileOutput | null;
  error: CompileDiagnostic | null;
  notice: string;
  busy: boolean;
  /** True when the artifact is an imported file, not this session's compile. */
  imported: boolean;
  generated: string;
  actions?: ReactNode;
  onCopy(): void;
  onDownload(): void;
  /** When present, a line-carrying error offers the way to it. */
  onErrorReveal?(line: number): void;
}) {
  const [tab, setTab] = useState(0);
  const { output, error, busy } = props;
  const showGenerated = props.generated.length > 0;
  const shown = showGenerated ? tab : Math.min(tab, 1);
  return <>
    {error && <Alert severity="error" sx={{ mb: 2, overflowWrap: 'anywhere' }}
      action={error.line && props.onErrorReveal
        ? <Button size="small" color="inherit" onClick={() => props.onErrorReveal!(error.line!)}>Go to line</Button>
        : undefined}>
      {diagnosticLabel(error)}
    </Alert>}
    {props.notice && <Alert severity="info" sx={{ mb: 2 }}>{props.notice}</Alert>}
    {output?.warnings?.map((warning, index) => <Alert key={`${warning.line ?? 0}:${warning.column ?? 0}:${index}`}
      severity="warning" sx={{ mb: 1, overflowWrap: 'anywhere' }}
      action={warning.line && props.onErrorReveal
        ? <Button size="small" color="inherit" onClick={() => props.onErrorReveal!(warning.line!)}>Go to line</Button>
        : undefined}>
      {diagnosticLabel(warning)}
    </Alert>)}
    {busy && <Typography color="text.secondary">Processing program…</Typography>}
    {!busy && !output && !error && <Typography color="text.secondary">Compile source or import an artifact to inspect the program.</Typography>}
    {output && <>
      <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
        <Chip label={`${output.byteSize} bytes`} size="small" />
        <Chip label={`${output.instructionCount} instructions`} size="small" />
        {props.imported && <Chip label="Imported artifact" size="small" variant="outlined" />}
      </Stack>
      <Typography variant="caption" color="text.secondary">PROGRAM HASH</Typography>
      <Box className="hash">{output.programHash}</Box>
      <Tabs value={shown} onChange={(_, value: number) => setTab(value)} sx={{ mt: 1 }}>
        <Tab label="Bytecode" />
        <Tab label="Disassembly" />
        {showGenerated && <Tab label="Generated source" />}
      </Tabs>
      {shown === 0 && <Box component="pre" className="code-output" aria-label="Compiled bytecode">{output.program}</Box>}
      {shown === 1 && <Box component="pre" className="code-output" aria-label="Disassembly">{output.disassembly.join('\n')}</Box>}
      {showGenerated && shown === 2 && <Box component="pre" className="code-output" aria-label="Generated source" title="Read-only: compiled directly from the graph">{props.generated}</Box>}
      <Stack direction="row" gap={1} sx={{ mt: 2 }} flexWrap="wrap">
        <Button variant="outlined" onClick={props.onCopy}>Copy bytecode</Button>
        <Button variant="outlined" onClick={props.onDownload}>Export artifact</Button>
      </Stack>
    </>}
    {props.actions}
  </>;
}

export function diagnosticLabel(diagnostic: CompileDiagnostic) {
  return diagnostic.line
    ? `Line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}: ${diagnostic.message}`
    : diagnostic.message;
}
