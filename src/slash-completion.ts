/** Returns the highlighted slash command for a partial, argument-free input. */
export function resolveSlashCommandCompletion(
  input: string,
  selectedCommand: string | undefined,
): string | null {
  const trimmed = input.trim();
  if (
    !selectedCommand ||
    !/^\/[^\s]*$/u.test(trimmed) ||
    trimmed === selectedCommand ||
    !selectedCommand.startsWith(trimmed)
  ) {
    return null;
  }
  return selectedCommand;
}
