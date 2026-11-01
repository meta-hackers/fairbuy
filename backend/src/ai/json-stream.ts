/** Emit complete object items from a top-level JSON array without accepting partial JSON. */
export function streamObjectArray(key: string, onItem: (item: unknown) => Promise<void>) {
  let text = '', offset = 0, depth = 0, stringStart = 0, itemStart = -1;
  let inString = false, escaped = false, arrayFound = false, finished = false;
  let property: string | null = null, awaitingArray = false;
  return async (delta: string) => {
    text += delta;
    for (; offset < text.length && !finished; offset++) {
      const char = text[offset];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') {
          inString = false;
          if (depth === 1) property = JSON.parse(text.slice(stringStart, offset + 1)) as string;
        }
        continue;
      }
      if (char === '"') { inString = true; stringStart = offset; continue; }
      if (/\s/.test(char)) continue;
      if (!arrayFound && depth === 1) {
        if (char === ':' && property === key) { awaitingArray = true; continue; }
        if (char === '[' && awaitingArray) arrayFound = true;
        property = null; awaitingArray = false;
      }
      if (char === '{' || char === '[') {
        if (arrayFound && depth === 2 && char === '{') itemStart = offset;
        depth++;
      } else if (char === '}' || char === ']') {
        depth--;
        if (arrayFound && depth === 2 && char === '}' && itemStart >= 0) {
          const item = JSON.parse(text.slice(itemStart, offset + 1)) as unknown;
          itemStart = -1;
          await onItem(item);
        }
        if (arrayFound && depth === 1) finished = true;
      }
    }
  };
}
