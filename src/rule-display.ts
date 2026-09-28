/** Removes parenthesized reference puzzle names from the primary rule copy. */
export function displayRuleText(text: string) {
  return text.replace(/（[^）]*）/g, "").replace(/\s+/g, " ").trim();
}
