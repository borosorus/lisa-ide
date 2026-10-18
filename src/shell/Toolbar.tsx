import { Button, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import FileUploadRoundedIcon from '@mui/icons-material/FileUploadRounded';
import CodeRoundedIcon from '@mui/icons-material/CodeRounded';
import AccountTreeRoundedIcon from '@mui/icons-material/AccountTreeRounded';
import type { AuthoringMode } from '../visual/storage';

/** Authoring mode and program-level actions, below the app identity header. */
export function Toolbar(props: {
  mode: AuthoringMode;
  busy: boolean;
  onModeChange(next: AuthoringMode): void;
  onCompile(): void;
  onImportFile(file: File): void;
}) {
  return <Stack className="toolbar" direction="row" alignItems="center" justifyContent="space-between" gap={2}>
    <ToggleButtonGroup size="small" exclusive value={props.mode} onChange={(_, next: AuthoringMode | null) => {
      if (next && next !== props.mode) props.onModeChange(next);
    }} aria-label="Authoring mode">
      <ToggleButton value="code">
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <CodeRoundedIcon fontSize="small" sx={{ mb: -0.2 }} />
          <span>Code</span>
        </Stack>
      </ToggleButton>
      <ToggleButton value="visual">
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <AccountTreeRoundedIcon fontSize="small" sx={{ mb: -0.2 }} />
          <span>Visual</span>
        </Stack>
      </ToggleButton>
    </ToggleButtonGroup>
    <Stack direction="row" gap={1} flexWrap="wrap" justifyContent="flex-end" alignItems="center">
      <Button variant="outlined" component="label" disabled={props.busy} startIcon={<FileUploadRoundedIcon fontSize="small" />}>
        Import artifact
        <input
          hidden
          type="file"
          accept=".json,application/json"
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) props.onImportFile(file);
          }}
        />
      </Button>
      <Button variant="contained" onClick={props.onCompile} disabled={props.busy}
        startIcon={props.busy ? undefined : <PlayArrowRoundedIcon fontSize="small" />}>
        {props.busy ? 'Working…' : 'Compile'}
      </Button>
    </Stack>
  </Stack>;
}
