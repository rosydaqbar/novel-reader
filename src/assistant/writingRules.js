import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ruleDirectory = fileURLToPath(new URL('./rules/', import.meta.url));

export const RULE_FILES = [
  'src/assistant/rules/humanizer.md',
  'src/assistant/rules/anti-ai-slop.md',
  'src/assistant/rules/banned-words.md'
];

export const HUMANIZER_RULES = fs.readFileSync(`${ruleDirectory}humanizer.md`, 'utf8');
export const ANTI_AI_SLOP_RULES = fs.readFileSync(`${ruleDirectory}anti-ai-slop.md`, 'utf8');
export const BANNED_WORDS = fs.readFileSync(`${ruleDirectory}banned-words.md`, 'utf8');

function list(values) {
  return Array.isArray(values) && values.length ? values.join(', ') : 'None provided';
}

export function composeSystemPrompt({ projectTitle, characterNames, codexNames } = {}) {
  return `You are a light-novel writer working inside the project "${projectTitle || 'Untitled project'}".

Project facts:
- Characters: ${list(characterNames)}
- Codex entries: ${list(codexNames)}

Write evocative, scene-aware prose that respects established characterization, continuity, and the user's requested mode.

## Humanizer rules

${HUMANIZER_RULES}

## Anti-AI-slop rules

${ANTI_AI_SLOP_RULES}

## Banned words and phrases

${BANNED_WORDS}

## Agent-loop operating instructions

Call tools before loading everything. Observe tool results. If context is thin, follow the codex mention chain. Never fabricate codex entries or characters. Use only the available project context for established facts. End with finalize.`;
}

export function buildGuardPrompt({ projectTitle, codexNames, chapterTitles, mode, prompt } = {}) {
  return `Classify whether a writing-assistant request is in scope for the project "${projectTitle || 'Untitled project'}".

Project codex names: ${list(codexNames)}
Project chapter titles: ${list(chapterTitles)}
Detected mode: ${mode || 'manual'}
User prompt: ${prompt || ''}

Rubric:
- IN_TOPIC: anything about this story, its characters, its world, its writing process, or its project context. Be permissive about form: outlines, half-formed thoughts, scene beats, character musings, worldbuilding, and meta-writing questions such as "is this a good beat?" are in topic when tied to the story.
- OUT_OF_TOPIC: genuinely unrelated subjects, including coding, recipes, other stories' characters, general chat, homework, or unrelated requests.
- Do not reject a request merely because it is incomplete, informal, exploratory, or asks for advice instead of prose.

Return only strict JSON with no markdown or extra text:
{"verdict":"in_topic"|"out_of_topic","reason":"<short reason>"}`;
}
