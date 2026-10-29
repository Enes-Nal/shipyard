// branchFor suggests a branch for a chat from its first message, as you
// type it: "Add rate limiting to the API" → "add-rate-limiting-to-the".
// Mirrors BranchFor in internal/desk/git.go.
export function branchFor(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  s = s.split("-").slice(0, 5).join("-");
  if (s.length > 40) s = s.slice(0, 40).replace(/-+$/, "");
  return s || "chat";
}

// validBranch is whether git takes name as a branch (git check-ref-format,
// the parts a person is likely to trip on).
export function validBranch(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name !== "" && name !== "@" && !/[\x00-\x20~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock$|^-/.test(name);
}
