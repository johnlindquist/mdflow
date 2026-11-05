import { filenameNamesEngine, hasInteractiveMarker, type EngineSource } from "./command";
import { isCompatOnlyFrontmatter } from "./compat";

/** One intent rule for discovery, coverage, guidance and both execution protocols. */
export function isDocument(path: string, frontmatter: Record<string, unknown>, source: EngineSource): boolean {
  return (source === "env" || source === "config" || source === "default") &&
    isCompatOnlyFrontmatter(frontmatter) && !hasInteractiveMarker(path) && !filenameNamesEngine(path);
}
