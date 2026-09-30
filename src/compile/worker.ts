/// <reference lib="webworker" />
import { compileSource } from './run';
import { SourceError } from './evaluate';
import type { CompileRequest, CompileResponse } from './types';

self.onmessage = (event: MessageEvent<CompileRequest>) => {
  const { id, source } = event.data;
  let response: CompileResponse;
  try {
    response = { id, ok: true, output: compileSource(source) };
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    response = {
      id, ok: false, error: error.message,
      ...(error instanceof SourceError && error.line ? { line: error.line, column: error.column } : {}),
    };
  }
  self.postMessage(response);
};
