import { expandIfFrames, IF_HEADER, IF_PADDING } from './containment';
import { isContainer, validElsePair } from './controlFlow';
import {
  IF_MIN_SIZE, isStatementNode,
  type GraphNode, type IfFrameSize, type Vec2, type VisualProject,
} from './model';
import { nodeSize, type Size } from './spawnPosition';

export interface ArrangeResult {
  readonly project: VisualProject;
  readonly changed: boolean;
  readonly warning?: string;
  readonly error?: string;
}

export type MeasuredNodeSizes = Readonly<Record<string, Size>>;

const HORIZONTAL_GAP = 72;
const VERTICAL_GAP = 48;
const PAIR_GAP = 56;
const CANVAS_PADDING = 64;

interface LayoutUnit {
  readonly key: string;
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly positions: ReadonlyMap<string, Vec2>;
  readonly members: readonly string[];
}

interface ScopeLayout {
  readonly width: number;
  readonly height: number;
  readonly positions: ReadonlyMap<string, Vec2>;
}

/**
 * Rebuilds only canvas geometry. Semantic nodes, edge connections, and node
 * array order are retained byte-for-byte; existing canvas positions are not
 * used to decide the new layout.
 */
export function arrangeProject(project: VisualProject, measured: MeasuredNodeSizes = {}): ArrangeResult {
  const byId = new Map<string, GraphNode>();
  for (const node of project.nodes) {
    if (byId.has(node.id)) return { project, changed: false, error: `Cannot arrange: duplicate node id "${node.id}".` };
    byId.set(node.id, node);
  }

  for (const node of project.nodes) {
    if (node.parent === undefined) continue;
    const parent = byId.get(node.parent);
    if (!parent) return { project, changed: false, error: `Cannot arrange: ${node.id} belongs to missing container "${node.parent}".` };
    if (!isContainer(parent)) return { project, changed: false, error: `Cannot arrange: ${node.id} belongs to non-container "${node.parent}".` };
  }
  for (const node of project.nodes) {
    const seen = new Set<string>([node.id]);
    let parentId = node.parent;
    while (parentId !== undefined) {
      if (seen.has(parentId)) return { project, changed: false, error: `Cannot arrange: container cycle includes "${parentId}".` };
      seen.add(parentId);
      parentId = byId.get(parentId)?.parent;
    }
  }

  const originalIndex = new Map(project.nodes.map((node, index) => [node.id, index] as const));
  const children = new Map<string | undefined, GraphNode[]>();
  for (const node of project.nodes) {
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }

  // Only a unique, structurally valid control edge makes a visual pair.
  const candidatePairs = project.edges.filter(edge => validElsePair(project, edge));
  const pairCounts = new Map<string, number>();
  for (const edge of candidatePairs) {
    pairCounts.set(edge.from.node, (pairCounts.get(edge.from.node) ?? 0) + 1);
    pairCounts.set(edge.to.node, (pairCounts.get(edge.to.node) ?? 0) + 1);
  }
  const elseForIf = new Map<string, string>();
  const ifForElse = new Map<string, string>();
  for (const edge of candidatePairs) {
    if (pairCounts.get(edge.from.node) !== 1 || pairCounts.get(edge.to.node) !== 1) continue;
    elseForIf.set(edge.from.node, edge.to.node);
    ifForElse.set(edge.to.node, edge.from.node);
  }

  const sizes = (node: GraphNode): Size => {
    if (isContainer(node)) return IF_MIN_SIZE;
    const measuredSize = measured[node.id];
    if (measuredSize && Number.isFinite(measuredSize.width) && Number.isFinite(measuredSize.height)
        && measuredSize.width > 0 && measuredSize.height > 0) return measuredSize;
    return nodeSize(node, project);
  };

  const frameSizes: Record<string, IfFrameSize> = {};
  const scopeMemo = new Map<string, ScopeLayout>();
  const containerMemo = new Map<string, LayoutUnit>();
  let recursiveFailure: string | undefined;

  const layoutContainer = (node: GraphNode): LayoutUnit => {
    const cached = containerMemo.get(node.id);
    if (cached) return cached;
    if (!isContainer(node)) throw new Error('layoutContainer received a non-container');
    const body = layoutScope(node.id);
    if (recursiveFailure) return emptyUnit(node.id, originalIndex.get(node.id) ?? 0);
    const width = Math.max(IF_MIN_SIZE.width, body.width + IF_PADDING * 2);
    // iframes() also enforces header + two padding bands + the tallest child.
    // Budget both bands here so post-layout normalization does not grow this
    // frame into the next sibling's reserved slot.
    const height = Math.max(IF_MIN_SIZE.height, body.height + IF_HEADER + IF_PADDING * 2);
    frameSizes[node.id] = { width, height };
    const positions = new Map<string, Vec2>([[node.id, { x: 0, y: 0 }]]);
    for (const [id, position] of body.positions) {
      positions.set(id, { x: position.x + IF_PADDING, y: position.y + IF_HEADER });
    }
    const members = [...positions.keys()];
    const unit: LayoutUnit = { key: node.id, index: originalIndex.get(node.id) ?? 0, width, height, positions, members };
    containerMemo.set(node.id, unit);
    return unit;
  };

  function emptyUnit(key: string, index: number): LayoutUnit {
    return { key, index, width: 0, height: 0, positions: new Map(), members: [] };
  }

  function layoutScope(parentId: string | undefined): ScopeLayout {
    const memoKey = parentId ?? '\u0000root';
    const cached = scopeMemo.get(memoKey);
    if (cached) return cached;
    // A containment cycle is rejected above, so reaching the same scope here
    // indicates no work rather than recursive re-entry.
    const siblings = children.get(parentId) ?? [];
    const units: LayoutUnit[] = [];
    const emitted = new Set<string>();
    for (const node of siblings) {
      if (emitted.has(node.id)) continue;
      const pairedElseId = node.kind === 'if' ? elseForIf.get(node.id) : undefined;
      if (pairedElseId && siblings.some(candidate => candidate.id === pairedElseId)) {
        const pairedElse = byId.get(pairedElseId)!;
        const ifUnit = layoutContainer(node);
        const elseUnit = layoutContainer(pairedElse);
        const positions = new Map<string, Vec2>();
        for (const [id, position] of ifUnit.positions) positions.set(id, position);
        for (const [id, position] of elseUnit.positions) {
          positions.set(id, { x: position.x + ifUnit.width + PAIR_GAP, y: position.y });
        }
        units.push({
          key: node.id,
          index: Math.min(originalIndex.get(node.id) ?? 0, originalIndex.get(pairedElseId) ?? 0),
          width: ifUnit.width + PAIR_GAP + elseUnit.width,
          height: Math.max(ifUnit.height, elseUnit.height),
          positions,
          members: [...ifUnit.members, ...elseUnit.members],
        });
        emitted.add(node.id);
        emitted.add(pairedElseId);
        continue;
      }
      if (node.kind === 'else' && ifForElse.has(node.id)) {
        const pairedIfId = ifForElse.get(node.id)!;
        if (siblings.some(candidate => candidate.id === pairedIfId)) continue;
      }
      units.push(isContainer(node)
        ? layoutContainer(node)
        : { key: node.id, index: originalIndex.get(node.id) ?? 0, ...sizes(node), positions: new Map([[node.id, { x: 0, y: 0 }]]), members: [node.id] });
      emitted.add(node.id);
    }

    // Collapse the local dependency graph into strongly connected groups.
    // This preserves a deterministic best-effort layout even for invalid
    // cyclic graphs without changing or dropping any actual edge.
    const owner = new Map<string, number>();
    units.forEach((unit, index) => unit.members.forEach(id => owner.set(id, index)));
    const adjacency = units.map(() => new Set<number>());
    const addDependency = (beforeId: string, afterId: string) => {
      const before = owner.get(beforeId);
      const after = owner.get(afterId);
      if (before === undefined || after === undefined || before === after) return;
      adjacency[before].add(after);
    };
    for (const edge of project.edges) {
      if (edge.kind === 'control') continue;
      addDependency(edge.from.node, edge.to.node);
    }
    for (const node of project.nodes) {
      if (!isStatementNode(node) || node.executionAfter === undefined) continue;
      addDependency(node.executionAfter, node.id);
    }

    const components = stronglyConnectedComponents(adjacency);
    const componentOf = new Map<number, number>();
    components.forEach((component, componentIndex) => component.forEach(unitIndex => componentOf.set(unitIndex, componentIndex)));
    const componentEdges = components.map(() => new Set<number>());
    const componentParents = components.map(() => new Set<number>());
    const indegree = components.map(() => 0);
    for (let from = 0; from < adjacency.length; from++) {
      for (const to of adjacency[from]) {
        const sourceComponent = componentOf.get(from)!;
        const targetComponent = componentOf.get(to)!;
        if (sourceComponent === targetComponent || componentEdges[sourceComponent].has(targetComponent)) continue;
        componentEdges[sourceComponent].add(targetComponent);
        componentParents[targetComponent].add(sourceComponent);
        indegree[targetComponent]++;
      }
    }
    const componentOrder = components.map((component, index) => ({
      index,
      order: Math.min(...component.map(unitIndex => units[unitIndex].index)),
    })).sort((a, b) => a.order - b.order || a.index - b.index);
    const queue = componentOrder.filter(item => indegree[item.index] === 0).map(item => item.index);
    const rank = components.map(() => 0);
    const orderedComponents: number[] = [];
    while (queue.length > 0) {
      queue.sort((a, b) => {
        const orderA = Math.min(...components[a].map(index => units[index].index));
        const orderB = Math.min(...components[b].map(index => units[index].index));
        return orderA - orderB || a - b;
      });
      const current = queue.shift()!;
      orderedComponents.push(current);
      for (const next of componentEdges[current]) {
        rank[next] = Math.max(rank[next], rank[current] + 1);
        indegree[next]--;
        if (indegree[next] === 0) queue.push(next);
      }
    }
    if (orderedComponents.length !== components.length) recursiveFailure = 'The dependency layout could not be resolved.';

    const columns = new Map<number, number[]>();
    for (const componentIndex of orderedComponents) {
      const column = columns.get(rank[componentIndex]) ?? [];
      column.push(componentIndex);
      columns.set(rank[componentIndex], column);
    }
    const componentBaseOrder = (componentIndex: number) =>
      Math.min(...components[componentIndex].map(unitIndex => units[unitIndex].index));

    // Sweep left to right once: align each component with the average row of
    // its upstream neighbors. Original node order breaks ties and anchors
    // components with no upstream dependencies.
    const componentOrderInColumn = new Map<number, number>();
    for (let r = 0; r <= Math.max(-1, ...columns.keys()); r++) {
      const column = columns.get(r);
      if (!column) continue;
      column.sort((a, b) => componentBaseOrder(a) - componentBaseOrder(b) || a - b);
      const originalOrder = new Map(column.map((componentIndex, index) => [componentIndex, index] as const));
      const upstreamOrder = (componentIndex: number) => {
        let total = 0;
        let count = 0;
        for (const parent of componentParents[componentIndex]) {
          if (rank[parent] >= r) continue;
          const order = componentOrderInColumn.get(parent);
          if (order === undefined) continue;
          total += order;
          count++;
        }
        return count === 0 ? originalOrder.get(componentIndex)! : total / count;
      };
      column.sort((a, b) => upstreamOrder(a) - upstreamOrder(b)
        || componentBaseOrder(a) - componentBaseOrder(b) || a - b);
      column.forEach((componentIndex, index) => componentOrderInColumn.set(componentIndex, index));
    }

    const maxRank = Math.max(-1, ...columns.keys());
    const columnWidths = Array.from({ length: maxRank + 1 }, (_, r) =>
      Math.max(0, ...(columns.get(r) ?? []).flatMap(component => components[component].map(index => units[index].width))));
    const columnX: number[] = [];
    for (let r = 0; r <= maxRank; r++) columnX[r] = r === 0 ? 0 : columnX[r - 1] + columnWidths[r - 1] + HORIZONTAL_GAP;

    const positions = new Map<string, Vec2>();
    const columnHeights: number[] = [];
    for (let r = 0; r <= maxRank; r++) {
      let y = 0;
      const componentIndices = columns.get(r) ?? [];
      for (const componentIndex of componentIndices) {
        const componentUnits = [...components[componentIndex]].sort((a, b) => units[a].index - units[b].index || a - b);
        for (const unitIndex of componentUnits) {
          const unit = units[unitIndex];
          for (const [id, position] of unit.positions) positions.set(id, { x: columnX[r] + position.x, y: y + position.y });
          y += unit.height + VERTICAL_GAP;
        }
      }
      columnHeights[r] = Math.max(0, y > 0 ? y - VERTICAL_GAP : 0);
    }
    const result: ScopeLayout = {
      width: columnWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, maxRank) * HORIZONTAL_GAP,
      height: Math.max(0, ...columnHeights),
      positions,
    };
    scopeMemo.set(memoKey, result);
    return result;
  }

  const root = layoutScope(undefined);
  if (recursiveFailure) return { project, changed: false, error: recursiveFailure };
  const positions: Record<string, Vec2> = { ...project.positions };
  for (const [id, position] of root.positions) {
    positions[id] = { x: position.x + CANVAS_PADDING, y: position.y + CANVAS_PADDING };
  }
  const nextFrameSizes: Record<string, IfFrameSize> = { ...project.frameSizes };
  for (const node of project.nodes) if (isContainer(node)) nextFrameSizes[node.id] = frameSizes[node.id] ?? IF_MIN_SIZE;
  for (const id of Object.keys(nextFrameSizes)) if (!byId.has(id) || !isContainer(byId.get(id)!)) delete nextFrameSizes[id];

  const arranged = expandIfFrames({ ...project, positions, frameSizes: nextFrameSizes });
  const changed = !sameRecord(project.positions, arranged.positions) || !sameFrames(project.frameSizes, arranged.frameSizes);
  const hasCycle = hasDependencyCycle(project);
  return {
    project: arranged,
    changed,
    ...(hasCycle ? { warning: 'Arranged best-effort; the graph contains dependency cycles.' } : {}),
  };
}

function stronglyConnectedComponents(adjacency: readonly ReadonlySet<number>[]): number[][] {
  let nextIndex = 0;
  const indices = Array<number>(adjacency.length).fill(-1);
  const low = Array<number>(adjacency.length).fill(-1);
  const stack: number[] = [];
  const onStack = new Set<number>();
  const components: number[][] = [];
  const visit = (node: number) => {
    indices[node] = low[node] = nextIndex++;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency[node]) {
      if (indices[target] === -1) {
        visit(target);
        low[node] = Math.min(low[node], low[target]);
      } else if (onStack.has(target)) low[node] = Math.min(low[node], indices[target]);
    }
    if (low[node] !== indices[node]) return;
    const component: number[] = [];
    let member: number;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  };
  for (let node = 0; node < adjacency.length; node++) if (indices[node] === -1) visit(node);
  return components;
}

function hasDependencyCycle(project: VisualProject): boolean {
  const ids = new Map(project.nodes.map((node, index) => [node.id, index] as const));
  const adjacency = project.nodes.map(() => new Set<number>());
  for (const edge of project.edges) {
    if (edge.kind === 'control') continue;
    const from = ids.get(edge.from.node);
    const to = ids.get(edge.to.node);
    if (from !== undefined && to !== undefined) adjacency[from].add(to);
  }
  for (const node of project.nodes) {
    if (!isStatementNode(node) || node.executionAfter === undefined) continue;
    const from = ids.get(node.executionAfter);
    const to = ids.get(node.id);
    if (from !== undefined && to !== undefined) adjacency[from].add(to);
  }
  return stronglyConnectedComponents(adjacency)
    .some(component => component.length > 1 || adjacency[component[0]].has(component[0]));
}

function sameRecord(a: Readonly<Record<string, Vec2>>, b: Readonly<Record<string, Vec2>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => a[key]?.x === b[key]?.x && a[key]?.y === b[key]?.y);
}

function sameFrames(a: Readonly<Record<string, IfFrameSize>>, b: Readonly<Record<string, IfFrameSize>>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => a[key]?.width === b[key]?.width && a[key]?.height === b[key]?.height);
}
