import { completeJSON } from './llmClient.js';

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function containsTerm(prompt, term) {
  const normalizedTerm = normalize(term);
  return normalizedTerm && ` ${prompt} `.includes(` ${normalizedTerm} `);
}

function factsTerms(projectFacts) {
  return [projectFacts?.title, ...(projectFacts?.characterNames ?? []), ...(projectFacts?.codexNames ?? []), ...(projectFacts?.codexAliases ?? []), ...(projectFacts?.chapterTitles ?? [])]
    .filter((term) => typeof term === 'string' && normalize(term));
}

const unrelatedSignals = /\b(?:code|coding|programming|javascript|typescript|python|react|api|database|recipe|recipes|cook|cooking|bake|baking|ingredients|homework|calculus|algebra|physics|chemistry|harry potter|hogwarts|weather|sports scores?)\b/i;

function buildGuardPrompt({ projectTitle, codexNames, chapterTitles, mode, prompt } = {}) {
  return `Classify whether a writing-assistant request is in scope for the project "${projectTitle || 'Untitled project'}".

Project codex names: ${Array.isArray(codexNames) && codexNames.length ? codexNames.join(', ') : 'None provided'}
Project chapter titles: ${Array.isArray(chapterTitles) && chapterTitles.length ? chapterTitles.join(', ') : 'None provided'}
Detected mode: ${mode || 'manual'}
User prompt: ${prompt || ''}

Return only strict JSON with no markdown or extra text:
{"verdict":"in_topic"|"out_of_topic","reason":"<short reason>"}`;
}

export async function runGuard({ prompt, mode, projectFacts, llmClient, signal }) {
  const normalizedPrompt = normalize(prompt);
  for (const term of factsTerms(projectFacts)) {
    if (containsTerm(normalizedPrompt, term)) return { verdict: 'in_topic', reason: `Matched project term: ${term}`, skipped: false };
  }
  if (unrelatedSignals.test(normalizedPrompt)) return { verdict: 'out_of_topic', reason: 'Prompt appears clearly unrelated to this writing project.', skipped: false };
  try {
    const response = await completeJSON({
      system: buildGuardPrompt({ projectTitle: projectFacts?.title, codexNames: [...(projectFacts?.codexNames ?? []), ...(projectFacts?.codexAliases ?? [])], chapterTitles: projectFacts?.chapterTitles ?? [], mode, prompt }),
      user: 'Return the JSON verdict for this request.', temperature: 0, maxTokens: 80, llmClient, signal
    });
    const parsed = JSON.parse(response);
    if (!['in_topic', 'out_of_topic'].includes(parsed?.verdict) || typeof parsed.reason !== 'string') throw new Error('Invalid guard verdict.');
    return { verdict: parsed.verdict, reason: parsed.reason, skipped: false };
  } catch {
    return { verdict: 'in_topic', skipped: true, reason: 'Guard unavailable, skipped' };
  }
}
