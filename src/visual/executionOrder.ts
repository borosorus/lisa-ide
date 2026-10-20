import { activeNodeIds } from './controlFlow';
import { isStatementNode, type VisualProject } from './model';
import { stableOrder } from './validate';

/** Explain why a candidate cannot be made to run after its selected predecessor. */
export function executionAfterIssue(
  project: VisualProject,
  nodeId: string,
  predecessorId: string,
  active = activeNodeIds(project),
): string | null {
  const target = project.nodes.find(node => node.id === nodeId);
  const predecessor = project.nodes.find(node => node.id === predecessorId);
  if (!target || !predecessor) return 'That statement is no longer available.';
  if (!isStatementNode(target) || !isStatementNode(predecessor)) return 'Order links can connect statement nodes only.';
  if (target.id === predecessor.id) return 'A statement cannot run after itself.';
  if (target.parent !== predecessor.parent) return 'Choose a statement in the same scope.';
  if (!active.has(target.id) || !active.has(predecessor.id)) return 'Both statements must be in an active branch.';

  // A structurally invalid existing graph cannot be made more misleading by
  // enabling additional order choices. The user can still clear an order.
  if (stableOrder(project).cycle.length > 0) return 'Resolve the existing execution cycle first.';
  const candidate: VisualProject = {
    ...project,
    nodes: project.nodes.map(node => node.id === target.id
      ? { ...node, executionAfter: predecessor.id } as typeof node
      : node),
  };
  return stableOrder(candidate).cycle.length === 0 ? null : 'This order would create a cycle with the data dependencies.';
}

/** Whether `predecessorId` can be added as a statement's explicit predecessor. */
export function canSetExecutionAfter(project: VisualProject, nodeId: string, predecessorId: string): boolean {
  return executionAfterIssue(project, nodeId, predecessorId) === null;
}
