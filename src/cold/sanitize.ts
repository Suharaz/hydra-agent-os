// Sanitises market-derived strings (symbols, token names, wallet labels, DEX metadata) before
// they are interpolated into LLM prompts. Strips control characters, neutralises common
// prompt-injection markers and truncates. Pure; no allocation beyond the result string.

const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g;
const FENCE = /`{3,}[^\n]*/g;
const ROLE_MARKER = /(^|[\s"'([{])(system|assistant|user|developer|tool)\s*:/gi;
const INJECTION = /\b(ignore|disregard|forget)\s+(all\s+|the\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|messages?|prompts?|rules?|context)\b/gi;
const TAGS = /<\/?\s*(system|instructions?|prompt|assistant|user|tool|im_start|im_end)\b[^>]*>/gi;
const BRACKET_MARKERS = /(\[|<\|)\s*(INST|SYS|system|im_start|im_end|end_of_turn|start_of_turn)\b[^\]|>]*(\]|\|>)/gi;
const WS = /\s+/g;

/** Strip control chars, code fences, role/instruction markers; collapse whitespace; cap at `max` chars. */
export function sanitize(s: string, max = 200): string {
  if (typeof s !== "string" || s.length === 0) return "";
  let out = s
    .replace(CONTROL, "")
    .replace(FENCE, " ")
    .replace(TAGS, " ")
    .replace(BRACKET_MARKERS, " ")
    .replace(INJECTION, "[redacted]")
    .replace(ROLE_MARKER, "$1$2 ")
    .replace(/`/g, "'")
    .replace(WS, " ")
    .trim();
  if (out.length > max) out = `${out.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
  return out;
}
