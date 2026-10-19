import { MenuItem, Select } from '@mui/material';

export interface ExampleOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

interface ExampleSelectProps<T extends ExampleOption> {
  options: readonly T[];
  ariaLabel: string;
  minWidth: number;
  maxWidth?: string;
  onSelect: (example: T) => void;
}

/** Shared example picker for code and canvas authoring modes. */
export function ExampleSelect<T extends ExampleOption>({
  options, ariaLabel, minWidth, maxWidth, onSelect,
}: ExampleSelectProps<T>) {
  return <Select<string>
    size="small"
    className="example-select-control"
    value=""
    displayEmpty
    aria-label={ariaLabel}
    MenuProps={{ slotProps: { paper: { className: 'example-select-menu' } } }}
    onChange={event => {
      const example = options.find(candidate => candidate.id === event.target.value);
      if (example) onSelect(example);
    }}
    sx={{ minWidth, ...(maxWidth ? { maxWidth } : {}) }}
  >
    <MenuItem value="" disabled>Load example…</MenuItem>
    {options.map(example => <MenuItem
      key={example.id}
      value={example.id}
      title={example.description}
    >
      {example.label}
    </MenuItem>)}
  </Select>;
}
