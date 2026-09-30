export const SOURCE_STORAGE_KEY = 'lisa-ide.source.v1';

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

export function loadStoredSource(
  storage: ReadStorage | null = typeof window === 'undefined' ? null : window.localStorage,
): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(SOURCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveStoredSource(
  source: string,
  storage: WriteStorage | null = typeof window === 'undefined' ? null : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(SOURCE_STORAGE_KEY, source);
  } catch {
    // Storage failures must not make the in-memory editor unusable.
  }
}
