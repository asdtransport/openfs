/**
 * Chroma grep strategy (stub)
 *
 * Translates grep patterns into Chroma $contains / $regex where filters.
 */

export function patternToChromaWhere(
  pattern: string,
  fixedString = false,
): Record<string, unknown> {
  if (fixedString) {
    return { $contains: pattern };
  }
  // Chroma supports $contains for simple substring matching
  // For regex, we'd need to use $regex (Chroma 1.x+)
  return { $contains: pattern };
}

// TODO: Implement full regex translation for Chroma 1.x $regex operator
