import { parse } from 'acorn';
import type { CompileDiagnostic } from './types';

type Node = { type: string; start: number; end: number; loc?: { start: { line: number; column: number } }; [key: string]: any };
type Environment = { results: Map<string, string>; successValues: Map<string, string> };
const resultDecoders = new Set(['word', 'uint256', 'bytes32', 'bool']);

/**
 * Advisory-only analysis for the documented straight-line tryCall patterns.
 * It recognizes p.if(result.success, thenCallback) and
 * p.revertUnless(result.success); it intentionally does not claim general JS
 * control-flow analysis.
 */
export function tryCallResultWarnings(source: string): CompileDiagnostic[] {
  let tree: Node;
  try {
    tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true }) as Node;
  } catch {
    return [];
  }
  const warnings: CompileDiagnostic[] = [];
  const warned = new Set<number>();

  const cloneEnv = (env: Environment): Environment => ({ results: new Map(env.results), successValues: new Map(env.successValues) });
  const cloneGuards = (guards: Set<string>) => new Set(guards);
  const memberName = (node: Node): string | undefined => node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    ? node.property.name : undefined;
  const tryOrigin = (node: Node, env: Environment): string | undefined => {
    if (node.type === 'Identifier') return env.results.get(node.name);
    if (node.type === 'CallExpression' && ['tryCall', 'tryStaticCall'].includes(memberName(node.callee) ?? '')) return `call@${node.start}`;
    return undefined;
  };
  const successOrigin = (node: Node, env: Environment): string | undefined => {
    if (node.type === 'Identifier') return env.successValues.get(node.name);
    if (memberName(node) === 'success') return tryOrigin(node.object, env);
    return undefined;
  };

  function visit(node: Node | null | undefined, env: Environment, guards: Set<string>): void {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Program' || node.type === 'BlockStatement') {
      const local = cloneEnv(env);
      for (const statement of node.body as Node[]) visit(statement, local, guards);
      return;
    }
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations as Node[]) {
        const id = declaration.id;
        const init = declaration.init as Node | null;
        if (id?.type === 'Identifier' && init) {
          const result = tryOrigin(init, env);
          const alias = init.type === 'Identifier' ? env.results.get(init.name) : undefined;
          const success = successOrigin(init, env);
          if (result) env.results.set(id.name, result);
          else if (alias) env.results.set(id.name, alias);
          else env.results.delete(id.name);
          if (success) env.successValues.set(id.name, success);
          else env.successValues.delete(id.name);
        }
        if (init) visit(init, env, guards);
      }
      return;
    }
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      visit(node.body, cloneEnv(env), cloneGuards(guards));
      return;
    }
    if (node.type === 'CallExpression') {
      const method = memberName(node.callee);
      const args = node.arguments as Node[];
      if (method === 'if' && args.length >= 2) {
        const guardedResult = successOrigin(args[0], env);
        visit(node.callee, env, guards);
        visit(args[0], env, guards);
        const thenGuards = cloneGuards(guards);
        if (guardedResult) thenGuards.add(guardedResult);
        visit(args[1], env, thenGuards);
        if (args[2]) visit(args[2], env, cloneGuards(guards));
        return;
      }
      if (method === 'revertUnless') {
        for (const arg of args) visit(arg, env, guards);
        const guardedResult = args[0] && successOrigin(args[0], env);
        if (guardedResult) guards.add(guardedResult);
        return;
      }
      const receiver = node.callee.type === 'MemberExpression' ? node.callee.object as Node : null;
      const result = receiver ? tryOrigin(receiver, env) : undefined;
      if (method && result && resultDecoders.has(method) && !guards.has(result) && !warned.has(node.start)) {
        warned.add(node.start);
        warnings.push({
          message: 'Try-call return data is decoded without a recognized success guard; use p.if(result.success, ...) or p.revertUnless(result.success).',
          ...(node.loc ? { line: node.loc.start.line, column: node.loc.start.column + 1 } : {}),
        });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['type', 'start', 'end', 'loc'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(child => child && typeof child === 'object' && visit(child as Node, env, guards));
      else if (value && typeof value === 'object') visit(value as Node, env, guards);
    }
  }
  visit(tree, { results: new Map(), successValues: new Map() }, new Set());
  return warnings;
}
