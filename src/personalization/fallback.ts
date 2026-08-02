import type { KnowledgeCandidate } from "./candidates.js";
import {
  finalizePersonalWiki,
  type PersonalFinalizeReport,
} from "./finalize.js";
import { mergeCandidatesDeterministically } from "./merge.js";

export interface PersonalFallbackResult {
  files: string[];
  report: PersonalFinalizeReport;
}

/**
 * Tool-less safety path for gateways that can extract candidates but cannot
 * drive the upstream Agent's filesystem tools. It consumes structured
 * candidates rather than raw conversations and shares the exact finalizer and
 * quality gate used by the normal path.
 */
export async function generatePersonalWikiFallback(
  wikiRoot: string,
  candidates: KnowledgeCandidate[],
  language: string,
  stateRoot?: string,
): Promise<PersonalFallbackResult> {
  const merge = await mergeCandidatesDeterministically(wikiRoot, candidates, {
    fallbackGenerated: true,
  });
  const report = await finalizePersonalWiki(wikiRoot, {
    allowFallbackGenerated: true,
    candidates,
    language,
    stateRoot,
  });
  return { files: merge.changedFiles, report };
}
