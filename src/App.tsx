import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, CssBaseline, Paper, Stack, Tab, Tabs, ThemeProvider, Typography, createTheme } from '@mui/material';
import { SourceEditor } from './editor/SourceEditor';
import { CompilerClient } from './compile/client';
import { createArtifact } from './compile/artifact';
import type { CompileOutput } from './compile/types';
import './styles.css';

const starter = `const p = createProgram();
const TOKEN = "0x1111111111111111111111111111111111111111";
const VAULT = "0x2222222222222222222222222222222222222222";

const balance = p
  .staticCall(TOKEN, encodeCall("balanceOf(address)", [SELF]))
  .uint256();

p.if(balance.gt(1000n), () => {
  p.call(VAULT, encodeCall("deposit(uint256)", [balance]));
});

return p;`;

const theme = createTheme({
  palette: { mode: 'dark', primary: { main: '#8ebdff' }, background: { default: '#0b1220', paper: '#172236' } },
  typography: { fontFamily: 'Inter, system-ui, sans-serif' },
  shape: { borderRadius: 10 },
});

export default function App() {
  const [source, setSource] = useState(starter);
  const [output, setOutput] = useState<CompileOutput | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(0);
  const [notice, setNotice] = useState('');
  const client = useRef<CompilerClient | null>(null);
  const revision = useRef(0);

  useEffect(() => () => client.current?.cancel(), []);

  function changeSource(next: string) {
    revision.current++;
    setSource(next);
    setOutput(null);
    setError('');
    setNotice('');
    client.current?.cancel();
    setBusy(false);
  }

  async function compile() {
    const currentRevision = revision.current;
    const compiler = client.current ?? new CompilerClient();
    client.current = compiler;
    setBusy(true);
    setError('');
    setNotice('');
    setOutput(null);
    try {
      const result = await compiler.compile(source);
      if (revision.current === currentRevision) setOutput(result);
    } catch (cause) {
      if (revision.current === currentRevision && (cause as Error).message !== 'Compilation cancelled')
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (revision.current === currentRevision) setBusy(false);
    }
  }

  async function copy() {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output.program);
      setNotice('Bytecode copied');
    } catch {
      setNotice('Clipboard unavailable in this browser');
    }
  }

  function download() {
    if (!output) return;
    const blob = new Blob([JSON.stringify(createArtifact(output), null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'lisa-program.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return <ThemeProvider theme={theme}>
    <CssBaseline />
    <Box className="app">
      <Stack className="topbar" direction="row" alignItems="center" justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h5" fontWeight={700}>LISA IDE</Typography>
          <Typography variant="body2" color="text.secondary">Write, compile, and inspect LISA programs</Typography>
        </Box>
        <Button variant="contained" onClick={compile} disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : undefined}>
          {busy ? 'Compiling…' : 'Compile'}
        </Button>
      </Stack>
      <Box className="workspace">
        <Paper className="pane source-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="subtitle2">Source</Typography>
            <Typography variant="caption" color="text.secondary">⌘ / Ctrl + Enter to compile</Typography>
          </Stack>
          <SourceEditor value={source} onChange={changeSource} onCompile={compile} />
        </Paper>
        <Paper className="pane output-pane" elevation={0}>
          <Box className="pane-heading"><Typography variant="subtitle2">Output</Typography></Box>
          <Box className="output-content">
            {error && <Alert severity="error" sx={{ mb: 2, overflowWrap: 'anywhere' }}>{error}</Alert>}
            {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}
            {busy && <Typography color="text.secondary">Compiling source…</Typography>}
            {!busy && !output && !error && <Typography color="text.secondary">Compile your source to inspect the program.</Typography>}
            {output && <>
              <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
                <Chip label={`${output.byteSize} bytes`} size="small" />
                <Chip label={`${output.instructionCount} instructions`} size="small" />
              </Stack>
              <Typography variant="caption" color="text.secondary">PROGRAM HASH</Typography>
              <Box className="hash">{output.programHash}</Box>
              <Tabs value={tab} onChange={(_, value: number) => setTab(value)} sx={{ mt: 1 }}>
                <Tab label="Bytecode" />
                <Tab label="Disassembly" />
              </Tabs>
              {tab === 0 ? <Box component="pre" className="code-output" aria-label="Compiled bytecode">{output.program}</Box>
                : <Box component="pre" className="code-output" aria-label="Disassembly">{output.disassembly.join('\n')}</Box>}
              <Stack direction="row" gap={1} sx={{ mt: 2 }}>
                <Button variant="outlined" onClick={copy}>Copy bytecode</Button>
                <Button variant="outlined" onClick={download}>Export artifact</Button>
              </Stack>
            </>}
          </Box>
        </Paper>
      </Box>
    </Box>
  </ThemeProvider>;
}
