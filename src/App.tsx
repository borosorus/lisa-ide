import { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, CssBaseline, MenuItem, Paper, Select,
  Stack, Tab, Tabs, ThemeProvider, Typography, createTheme,
} from '@mui/material';
import { SourceEditor } from './editor/SourceEditor';
import { SOURCE_EXAMPLES, STARTER_SOURCE } from './editor/examples';
import { loadStoredSource, saveStoredSource } from './editor/sourceStorage';
import { CompilerClient, CompilerError } from './compile/client';
import { createArtifact, parseArtifact, type ProgramArtifact } from './compile/artifact';
import type { CompileDiagnostic, CompileOutput } from './compile/types';
import './styles.css';

const theme = createTheme({
  palette: { mode: 'dark', primary: { main: '#8ebdff' }, background: { default: '#0b1220', paper: '#172236' } },
  typography: { fontFamily: 'Inter, system-ui, sans-serif' },
  shape: { borderRadius: 10 },
});

function diagnosticFrom(error: unknown): CompileDiagnostic {
  if (error instanceof CompilerError) return error.diagnostic;
  return { message: error instanceof Error ? error.message : String(error) };
}

function diagnosticLabel(diagnostic: CompileDiagnostic) {
  return diagnostic.line
    ? `Line ${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}: ${diagnostic.message}`
    : diagnostic.message;
}

export default function App() {
  const [source, setSource] = useState(() => loadStoredSource() ?? STARTER_SOURCE);
  const [output, setOutput] = useState<CompileOutput | null>(null);
  const [importedArtifact, setImportedArtifact] = useState<ProgramArtifact | null>(null);
  const [error, setError] = useState<CompileDiagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(0);
  const [notice, setNotice] = useState('');
  const client = useRef<CompilerClient | null>(null);
  const revision = useRef(0);

  useEffect(() => () => client.current?.cancel(), []);
  useEffect(() => saveStoredSource(source), [source]);

  function replaceSource(next: string, nextNotice = '') {
    if (next === source) {
      setNotice(nextNotice);
      return;
    }
    revision.current++;
    setSource(next);
    setOutput(null);
    setImportedArtifact(null);
    setError(null);
    setNotice(nextNotice);
    client.current?.cancel();
    setBusy(false);
  }

  async function compile() {
    const currentRevision = revision.current;
    const compiler = client.current ?? new CompilerClient();
    client.current = compiler;
    setBusy(true);
    setError(null);
    setNotice('');
    setOutput(null);
    setImportedArtifact(null);
    try {
      const result = await compiler.compile(source);
      if (revision.current === currentRevision) setOutput(result);
    } catch (cause) {
      if (revision.current === currentRevision && (cause as Error).message !== 'Compilation cancelled') {
        setError(diagnosticFrom(cause));
      }
    } finally {
      if (revision.current === currentRevision) setBusy(false);
    }
  }

  async function importArtifact(file: File) {
    const currentRevision = revision.current;
    const compiler = client.current ?? new CompilerClient();
    client.current = compiler;
    setBusy(true);
    setError(null);
    setNotice('');
    setOutput(null);
    try {
      const artifact = parseArtifact(await file.text());
      const result = await compiler.inspect(artifact.program);
      if (revision.current === currentRevision) {
        setImportedArtifact(artifact);
        setOutput(result);
        setNotice(`Imported ${file.name} · ${artifact.compiler.name} ${artifact.compiler.version}`);
      }
    } catch (cause) {
      if (revision.current === currentRevision && (cause as Error).message !== 'Compilation cancelled') {
        setImportedArtifact(null);
        setError(diagnosticFrom(cause));
      }
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
    const artifact = importedArtifact ?? createArtifact(output);
    const blob = new Blob([JSON.stringify(artifact, null, 2) + '\n'], { type: 'application/json' });
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
        <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end">
          <Button variant="outlined" component="label" disabled={busy}>
            Import artifact
            <input
              hidden
              type="file"
              accept=".json,application/json"
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void importArtifact(file);
              }}
            />
          </Button>
          <Button variant="contained" onClick={compile} disabled={busy} startIcon={busy ? <CircularProgress size={16} /> : undefined}>
            {busy ? 'Working…' : 'Compile'}
          </Button>
        </Stack>
      </Stack>
      <Box className="workspace">
        <Paper className="pane source-pane" elevation={0}>
          <Stack className="pane-heading" direction="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Typography variant="subtitle2">Source</Typography>
            <Stack direction="row" alignItems="center" gap={1}>
              <Select
                size="small"
                value=""
                displayEmpty
                aria-label="Load example"
                onChange={event => {
                  const example = SOURCE_EXAMPLES.find(candidate => candidate.id === event.target.value);
                  if (example) replaceSource(example.source, `Loaded example: ${example.label}`);
                }}
                sx={{ minWidth: 170 }}
              >
                <MenuItem value="" disabled>Load example…</MenuItem>
                {SOURCE_EXAMPLES.map(example => (
                  <MenuItem key={example.id} value={example.id}>{example.label}</MenuItem>
                ))}
              </Select>
              <Typography variant="caption" color="text.secondary">⌘ / Ctrl + Enter</Typography>
            </Stack>
          </Stack>
          <SourceEditor
            value={source}
            onChange={next => replaceSource(next)}
            onCompile={compile}
            diagnostic={error}
          />
        </Paper>
        <Paper className="pane output-pane" elevation={0}>
          <Box className="pane-heading"><Typography variant="subtitle2">Output</Typography></Box>
          <Box className="output-content">
            {error && <Alert severity="error" sx={{ mb: 2, overflowWrap: 'anywhere' }}>{diagnosticLabel(error)}</Alert>}
            {notice && <Alert severity="info" sx={{ mb: 2 }}>{notice}</Alert>}
            {busy && <Typography color="text.secondary">Processing program…</Typography>}
            {!busy && !output && !error && <Typography color="text.secondary">Compile source or import an artifact to inspect the program.</Typography>}
            {output && <>
              <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
                <Chip label={`${output.byteSize} bytes`} size="small" />
                <Chip label={`${output.instructionCount} instructions`} size="small" />
                {importedArtifact && <Chip label="Imported artifact" size="small" variant="outlined" />}
              </Stack>
              <Typography variant="caption" color="text.secondary">PROGRAM HASH</Typography>
              <Box className="hash">{output.programHash}</Box>
              <Tabs value={tab} onChange={(_, value: number) => setTab(value)} sx={{ mt: 1 }}>
                <Tab label="Bytecode" />
                <Tab label="Disassembly" />
              </Tabs>
              {tab === 0 ? <Box component="pre" className="code-output" aria-label="Compiled bytecode">{output.program}</Box>
                : <Box component="pre" className="code-output" aria-label="Disassembly">{output.disassembly.join('\n')}</Box>}
              <Stack direction="row" gap={1} sx={{ mt: 2 }} flexWrap="wrap">
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
