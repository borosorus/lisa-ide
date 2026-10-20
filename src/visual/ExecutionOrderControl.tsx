import { Button, Chip, Tooltip } from '@mui/material';
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { isStatementNode, type VisualProject } from './model';
import { nodeLabel } from './flowNodes';

interface Props {
  project: VisualProject;
  nodeId: string;
  isOrdering: boolean;
  onToggle(): void;
  onClear(): void;
}

/** Selected-node actions for choosing a successor and clearing an order rule. */
export function ExecutionOrderControl({ project, nodeId, isOrdering, onToggle, onClear }: Props) {
  const node = project.nodes.find(candidate => candidate.id === nodeId);
  if (!node || !isStatementNode(node)) return null;

  const predecessor = node.executionAfter === undefined
    ? undefined
    : project.nodes.find(candidate => candidate.id === node.executionAfter);
  const predecessorLabel = predecessor && isStatementNode(predecessor)
    ? `${nodeLabel(predecessor, project)} (${predecessor.id})`
    : node.executionAfter ? `Unavailable (${node.executionAfter})` : '';

  return <>
    <Tooltip title={isOrdering ? 'Cancel choosing a statement to run after this one' : 'Choose a statement that should run after this one'}>
      <Button size="small" variant={isOrdering || node.executionAfter ? 'contained' : 'outlined'}
        startIcon={isOrdering ? <CloseRoundedIcon /> : <AltRouteRoundedIcon />}
        aria-pressed={isOrdering} onClick={event => {
          event.stopPropagation();
          onToggle();
        }}>
        {isOrdering ? 'Cancel' : 'Order'}
      </Button>
    </Tooltip>
    {node.executionAfter !== undefined && <Tooltip title="Use automatic order for this statement">
      <Chip size="small" className="execution-order-chip" label={`After ${predecessorLabel}`}
        onDelete={event => {
          event.stopPropagation();
          onClear();
        }} deleteIcon={<CloseRoundedIcon />}
        onClick={event => event.stopPropagation()} />
    </Tooltip>}
  </>;
}
