// the ghost suggestion: the most recent history entry the input begins,
// drawn muted after the caret; the right arrow takes it. history only,
// never a guess, so what appears is always something already typed.
export function suggest(input: string, history: string[]): string {
  if (!input.trim()) return "";
  for (const h of history) {
    if (h.length > input.length && h.startsWith(input)) return h.slice(input.length);
  }
  return "";
}
