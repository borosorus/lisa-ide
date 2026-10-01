import { parse } from 'acorn';
import {
  CALLER, GAS, SELF, SELFBALANCE, TIMESTAMP, CallResult, ProgramBuilder, Value,
  createProgram, encodeCall, rawCalldata, toValue,
} from '@bosorus/lisa-evm';

type AstNode = { type: string; start: number; loc: { start: { line: number; column: number } }; [key: string]: any };
type Scope = Map<string, unknown>;

export class SourceError extends Error {
  constructor(message: string, readonly line?: number, readonly column?: number) {
    super(message);
    this.name = 'SourceError';
  }
}

const helpers: Readonly<Record<string, unknown>> = Object.freeze({
  createProgram, encodeCall, rawCalldata, SELF, CALLER, GAS, TIMESTAMP, SELFBALANCE,
});
const builderMethods = new Set(['staticCall', 'call', 'if']);
const valueMethods = new Set(['add', 'sub', 'mul', 'div', 'lt', 'gt', 'eq']);
const resultMethods = new Set(['word', 'uint256', 'bytes32', 'bool']);

function error(node: AstNode, message: string): never {
  throw new SourceError(message, node.loc.start.line, node.loc.start.column + 1);
}

/** Execute only the documented LISA authoring subset; no JS globals or property reads. */
export function evaluateSource(source: string): ProgramBuilder {
  if (source.length > 32_768) throw new SourceError('Source exceeds 32 KiB');
  let tree: AstNode;
  try {
    tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true }) as AstNode;
  } catch (cause) {
    const e = cause as { message: string; loc?: { line: number; column: number } };
    throw new SourceError(e.message, e.loc?.line, e.loc ? e.loc.column + 1 : undefined);
  }

  let steps = 0;
  const tick = (node: AstNode, depth: number) => {
    if (++steps > 2000 || depth > 80) error(node, 'Source is too complex');
  };

  function expression(node: AstNode, scope: Scope, depth: number): unknown {
    tick(node, depth);
    switch (node.type) {
      case 'Literal':
        if (typeof node.value === 'string' || typeof node.value === 'number' ||
            typeof node.value === 'bigint' || typeof node.value === 'boolean') return node.value;
        return error(node, 'Unsupported literal');
      case 'Identifier':
        if (scope.has(node.name)) return scope.get(node.name);
        if (Object.hasOwn(helpers, node.name)) return helpers[node.name];
        return error(node, `Unknown name: ${node.name}`);
      case 'ArrayExpression':
        if (node.elements.some((item: AstNode | null) => item === null || item.type === 'SpreadElement'))
          return error(node, 'Array holes and spread are not supported');
        return node.elements.map((item: AstNode) => expression(item, scope, depth + 1));
      case 'CallExpression': {
        if (node.optional || node.arguments.some((arg: AstNode) => arg.type === 'SpreadElement'))
          return error(node, 'Optional calls and spread are not supported');
        const callee = node.callee as AstNode;
        const args = node.arguments.map((arg: AstNode) => expression(arg, scope, depth + 1));
        try {
          if (callee.type === 'Identifier' && ['createProgram', 'encodeCall', 'rawCalldata'].includes(callee.name)) {
            const fn = helpers[callee.name] as (...args: any[]) => unknown;
            return fn(...args);
          }
          if (callee.type === 'MemberExpression' && !callee.computed && !callee.optional && callee.property.type === 'Identifier') {
            const receiver0 = expression(callee.object, scope, depth + 1);
            const method = callee.property.name as string;
            // Value-like receivers (e.g. `(1n).add(2n)`) coerce exactly as builder
            // arguments do; booleans have no word representation.
            let receiver: unknown = receiver0;
            if (typeof receiver0 === 'bigint' || typeof receiver0 === 'number' || typeof receiver0 === 'string') {
              receiver = toValue(receiver0);
            } else if (typeof receiver0 === 'boolean') {
              return error(callee, 'A boolean is not a numeric value');
            }
            const allowed = receiver instanceof ProgramBuilder ? builderMethods
              : receiver instanceof Value ? valueMethods
              : receiver instanceof CallResult ? resultMethods : undefined;
            if (!allowed?.has(method)) return error(callee, `Method is not available: ${method}`);
            if ((allowed === valueMethods && args.some((arg: unknown) => typeof arg === 'boolean'))
                || (method === 'if' && typeof args[0] === 'boolean')) {
              return error(node, 'A boolean is not a numeric value');
            }
            if (method === 'if') {
              const callback = node.arguments[1] as AstNode | undefined;
              if (args.length !== 2 || !callback || callback.type !== 'ArrowFunctionExpression')
                return error(node, 'p.if requires a zero-argument arrow callback');
            }
            return (receiver as any)[method](...args);
          }
          return error(callee, 'Only LISA helper and method calls are supported');
        } catch (cause) {
          if (cause instanceof SourceError) throw cause;
          return error(node, cause instanceof Error ? cause.message : String(cause));
        }
      }
      case 'ArrowFunctionExpression':
        if (node.async || node.params.length || node.body.type !== 'BlockStatement')
          return error(node, 'Only zero-argument block callbacks are supported');
        return () => {
          const child = new Map(scope);
          statements(node.body.body, child, depth + 1, false);
        };
      default:
        return error(node, `Unsupported syntax: ${node.type}`);
    }
  }

  function statements(nodes: AstNode[], scope: Scope, depth: number, topLevel: boolean): ProgramBuilder | undefined {
    let result: ProgramBuilder | undefined;
    for (const [index, node] of nodes.entries()) {
      tick(node, depth);
      if (node.type === 'VariableDeclaration' && node.kind === 'const') {
        for (const declaration of node.declarations as AstNode[]) {
          if (declaration.id.type !== 'Identifier' || !declaration.init) error(declaration, 'Use const name = expression');
          const name = declaration.id.name as string;
          if (scope.has(name) || Object.hasOwn(helpers, name)) error(declaration, `Name already defined: ${name}`);
          scope.set(name, expression(declaration.init, scope, depth + 1));
        }
      } else if (node.type === 'ExpressionStatement') {
        if (node.expression.type !== 'CallExpression') error(node, 'Only calls may be used as statements');
        expression(node.expression, scope, depth + 1);
      } else if (node.type === 'ReturnStatement' && topLevel) {
        if (index !== nodes.length - 1 || !node.argument) error(node, 'return p must be the final statement');
        const value = expression(node.argument, scope, depth + 1);
        if (!(value instanceof ProgramBuilder)) error(node, 'Return a LISA program builder');
        result = value;
      } else {
        error(node, `Unsupported statement: ${node.type}`);
      }
    }
    return result;
  }

  const result = statements(tree.body, new Map(), 0, true);
  if (!result) throw new SourceError('End source with return p;');
  return result;
}
