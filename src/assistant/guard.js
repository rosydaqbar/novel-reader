import { completeJSON } from './llmClient.js';
import { buildGuardPrompt } from './writingRules.js';

function normalize(value) {
  return String(value ?? '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsTerm(prompt, term) {
  const normalizedTerm = normalize(term);
  return normalizedTerm && ` ${prompt} `.includes(` ${normalizedTerm} `);
}

function factsTerms(projectFacts) {
  return [
    projectFacts?.title,
    ...(projectFacts?.characterNames ?? []),
    ...(projectFacts?.codexNames ?? []),
    ...(projectFacts?.codexAliases ?? []),
    ...(projectFacts?.chapterTitles ?? [])
  ].filter((term) => typeof term === 'string' && normalize(term));
}

const unrelatedSignals = /\b(?:code|coding|programming|javascript|typescript|python|react|api|database|recipe|recipes|cook|cooking|bake|baking|ingredients|homework|calculus|algebra|physics|chemistry|harry potter|hogwarts|weather|sports scores?)\b/i;

export function checkHeuristic({ prompt, projectFacts }) {
  const normalizedPrompt = normalize(prompt);
  for (const term of factsTerms(projectFacts)) {
    if (containsTerm(normalizedPrompt, term)) {
      return { result: 'in_topic', reason: `Matched project term: ${term}` };
    }
  }
  if (unrelatedSignals.test(normalizedPrompt)) {
    return { result: 'out_of_topic', reason: 'Prompt appears clearly unrelated to this writing project.' };
  }
  return { result: 'ambiguous' };
}

export async function runGuard({ prompt, mode, projectFacts, llmClient, signal }) {
  const heuristic = checkHeuristic({ prompt, projectFacts });
  if (heuristic.result === 'in_topic' || heuristic.result === 'out_of_topic') {
    return { verdict: heuristic.result, reason: heuristic.reason, skipped: false };
  }

  try {
    const response = await completeJSON({
      system: buildGuardPrompt({
        projectTitle: projectFacts?.title,
        codexNames: [...(projectFacts?.codexNames ?? []), ...(projectFacts?.codexAliases ?? [])],
        chapterTitles: projectFacts?.chapterTitles ?? [],
        mode,
        prompt
      }),
      user: 'Return the JSON verdict for this request.',
      temperature: 0,
      maxTokens: 80,
      llmClient,
      signal
    });
    const parsed = JSON.parse(response);
    if (!['in_topic', 'out_of_topic'].includes(parsed?.verdict) || typeof parsed.reason !== 'string') throw new Error('Invalid guard verdict.');
    return { verdict: parsed.verdict, reason: parsed.reason, skipped: false };
  } catch {
    return { verdict: 'in_topic', skipped: true, reason: 'Guard unavailable, skipped' };
  }
}
