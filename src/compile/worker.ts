/// <reference lib="webworker" />
import { compileSource, inspectProgram } from './run';
import { SourceError } from './evaluate';
import type { CompileRequest, CompileResponse } from './types';

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  const request = event.data;
  let response: CompileResponse;
  try {
    const output = request.kind === 'compile'
      ? compileSource(request.source)
      : inspectProgram(request.program);
    response = { id: request.id, ok: true, output };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    response = {
      id: request.id,
      ok: false,
      error: error.message,
      ...(error instanceof SourceError && error.line ? { line: error.line, column: error.column } : {}),
    };
  }
  self.postMessage(response);
};
