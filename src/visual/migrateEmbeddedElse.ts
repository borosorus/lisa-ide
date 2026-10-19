import { createId, IF_DEFAULT_SIZE, IF_MIN_SIZE, type GraphEdge, type GraphNode, type IfFrameSize, type Vec2 } from './model';

interface MigrationInput {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly positions: Readonly<Record<string, Vec2>>;
  readonly frameSizes: Readonly<Record<string, IfFrameSize>>;
}

interface MigrationOutput {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly positions: Record<string, Vec2>;
  readonly frameSizes: Record<string, IfFrameSize>;
}

/** Convert version 1's embedded branch marker into paired container nodes. */
export function migrateEmbeddedElse(input: MigrationInput): MigrationOutput {
  const nodes: GraphNode[] = [];
  const edges = [...input.edges];
  const positions = { ...input.positions };
  const frameSizes = { ...input.frameSizes };
  const usedNodeIds = input.nodes.map(node => node.id);
  const usedEdgeIds = edges.map(edge => edge.id);
  const elseByIf = new Map<string, string>();
  const elseNodes: GraphNode[] = [];
  const branchWidths = new Map<string, number>();

  for (const node of input.nodes) {
    if (node.kind !== 'if' || node.hasElse !== true) continue;
    const elseId = createId(usedNodeIds, 'else');
    usedNodeIds.push(elseId);
    elseByIf.set(node.id, elseId);
    elseNodes.push({ id: elseId, kind: 'else', ...(node.parent === undefined ? {} : { parent: node.parent }) });
    const oldSize = frameSizes[node.id] ?? IF_DEFAULT_SIZE;
    const branchWidth = Math.max(IF_MIN_SIZE.width, Math.floor((oldSize.width - 56) / 2));
    branchWidths.set(node.id, branchWidth);
    frameSizes[node.id] = { width: branchWidth, height: oldSize.height };
    frameSizes[elseId] = { width: branchWidth, height: oldSize.height };
    const origin = positions[node.id] ?? { x: 0, y: 0 };
    const elsePosition = { x: origin.x + branchWidth + 56, y: origin.y };
    positions[elseId] = elsePosition;
    const edgeId = createId(usedEdgeIds, 'e');
    usedEdgeIds.push(edgeId);
    edges.push({ id: edgeId, kind: 'control', from: { node: node.id, port: 'else' }, to: { node: elseId, port: 'if' } });
  }

  // Canonicalize ownership first. Geometry conversion then proceeds from
  // outer IFs inward, so nested IFs already sit in their final ELSE scope.
  for (const node of input.nodes) {
    const { branch, hasElse, ...clean } = node as GraphNode & { branch?: 'then' | 'else'; hasElse?: boolean };
    if (node.parent !== undefined && branch === 'else') {
      const elseId = elseByIf.get(node.parent);
      if (elseId !== undefined) {
        nodes.push({ ...clean, parent: elseId } as GraphNode);
        continue;
      }
    }
    nodes.push(clean as GraphNode);
  }
  const depthOf = (id: string): number => {
    let depth = 0;
    let parent = input.nodes.find(node => node.id === id)?.parent;
    const seen = new Set<string>([id]);
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent);
      depth++;
      parent = input.nodes.find(node => node.id === parent)?.parent;
    }
    return depth;
  };
  const owners = [...elseByIf.keys()].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  const canonicalNodes = [...nodes, ...elseNodes];
  for (const ifId of owners) {
    const elseId = elseByIf.get(ifId)!;
    const oldSize = input.frameSizes[ifId] ?? IF_DEFAULT_SIZE;
    const width = branchWidths.get(ifId)!;
    const origin = positions[ifId] ?? { x: 0, y: 0 };
    positions[elseId] = { x: origin.x + width + 56, y: origin.y };
    const shift = width + 56 - oldSize.width / 2;
    for (const legacyChild of input.nodes) {
      if (legacyChild.parent === ifId && legacyChild.branch === 'else') {
        moveSubtree(legacyChild.id, shift, canonicalNodes, positions, elseByIf);
      }
    }
  }

  const transformedById = new Map(nodes.map(node => [node.id, node] as const));
  for (const [ifId, elseId] of elseByIf) {
    const parent = transformedById.get(ifId)?.parent;
    const elseIndex = elseNodes.findIndex(node => node.id === elseId);
    if (elseIndex < 0) continue;
    const { parent: _oldParent, ...unparented } = elseNodes[elseIndex];
    elseNodes[elseIndex] = parent === undefined
      ? unparented as GraphNode
      : { ...unparented, parent } as GraphNode;
  }
  return { nodes: [...nodes, ...elseNodes], edges, positions, frameSizes };
}

function moveSubtree(
  rootId: string, dx: number, nodes: readonly GraphNode[], positions: Record<string, Vec2>, elseByIf: ReadonlyMap<string, string>,
): void {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parent === undefined) continue;
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node.id);
    children.set(node.parent, siblings);
  }
  const pending = [rootId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const at = positions[id] ?? { x: 0, y: 0 };
    positions[id] = { x: at.x + dx, y: at.y };
    pending.push(...(children.get(id) ?? []));
    const pairedId = elseByIf.get(id);
    if (pairedId !== undefined) pending.push(pairedId);
  }
}
