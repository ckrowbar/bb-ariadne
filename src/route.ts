// The workstream page lives at the Ariadne panel's subPath.
//
// BB encodes each subPath segment when navigating and hands the component the
// raw, still-encoded route remainder. So callers pass the plain name as
// subPath, and the page decodes the whole remainder once. Encoding the name as
// well would double-encode it, and a name like "my feature" would not match.

/** The workstream a subPath points at, or null at the panel root. */
export function workstreamFromSubPath(subPath: string): string | null {
  if (subPath === "") return null;
  try {
    return decodeURIComponent(subPath);
  } catch {
    return subPath;
  }
}
