// === captcha-solvers.js ===
/**
 * @module captcha-solvers
 * @description The captchas a small site writes itself, answered locally.
 *
 *   "What is 3 + 4?", "How many letters are in CAT?", "Type the third word of
 *   this sentence" — challenges with no service behind them, no image to read
 *   and no money to spend. They are common on forum software, on club and
 *   council sites, and on anything built before the widget era.
 *
 *   The one rule this file is written around: **a wrong answer is worse than
 *   no answer.** A guess submitted to a form is a failed attempt the site
 *   records against you, and on most of these there are three of those before
 *   a lockout; a refusal costs a pause the user was going to see anyway. So
 *   every parser here returns null the moment it is not certain, and the
 *   caller falls through to the pause-and-ask path that existed before
 *   (K-02). Nothing here ever approximates.
 *
 *   It lives in utils/ rather than in the page because the worker decides what
 *   the page saw — the same split as ASSERT and IF_ELSE (K-13). The page
 *   reports the challenge text; this reads it.
 *
 * @dependencies none
 */

"use strict";

/** Numbers a challenge writes as words. Nothing above twenty appears in one. */
const NUMBER_WORDS = Object.freeze({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
});

/** Positions a "which word" challenge names. */
const ORDINALS = Object.freeze({
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
});

const NUM = `(?:\\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")})`;
const OP = "\\+|plus|-|−|–|minus|\\*|×|x|times|/|÷|divided by";

/**
 * Words that carry no arithmetic. What is left of a challenge once the sum and
 * these are removed has to be nothing at all, or the text is saying something
 * this file does not understand and must not answer.
 */
const FILLER =
  /\b(what|whats|is|are|does|do|the|a|an|of|to|in|please|solve|calculate|compute|work|out|enter|type|write|answer|result|sum|total|equals|equal|value|below|above|following|question|security|check|captcha|anti|spam|verification|verify|prove|you|your|human|not|robot|bot|math|maths|arithmetic|simple|and|make|makes|plus|add|added|together)\b/gi;

/** @param {string} token @returns {number|null} */
function _num(token) {
  const word = String(token).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word)) {
    return NUMBER_WORDS[word];
  }
  return /^\d{1,4}$/.test(word) ? Number(word) : null;
}

/** @param {string} raw @returns {string} */
function _normalize(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is the sum essentially the whole of the text?
 *
 * "What is 3 + 4?" is. "Ship 3 + 4 boxes to the address below" is not, and
 * answering it would be filling a delivery form with a 7.
 *
 * @param {string} text - the whole challenge
 * @param {string} matched - the part read as arithmetic
 */
function _isJustTheSum(text, matched) {
  const rest = text
    .replace(matched, " ")
    .replace(FILLER, " ")
    .replace(/[^a-z0-9]/gi, " ")
    .trim();
  return rest === "";
}

/**
 * `3 + 4`, `three times two`, `the sum of 6 and 1`.
 * @param {string} text
 * @returns {{answer: string, how: string}|null}
 */
function _arithmetic(text) {
  const infix = [
    ...text.matchAll(new RegExp(`(${NUM})\\s*(${OP})\\s*(${NUM})`, "gi")),
  ];
  const worded = [
    ...text.matchAll(
      new RegExp(`(?:sum|total)\\s+of\\s+(${NUM})\\s+and\\s+(${NUM})`, "gi"),
    ),
  ];

  // Two sums in one challenge is a challenge with a structure this does not
  // model — "add 2 + 3 and then 4 + 5" has an answer, and it is not either of
  // them.
  if (infix.length + worded.length !== 1) return null;

  let a;
  let b;
  let op;
  let matched;
  if (worded.length === 1) {
    matched = worded[0][0];
    a = _num(worded[0][1]);
    b = _num(worded[0][2]);
    op = "+";
  } else {
    matched = infix[0][0];
    a = _num(infix[0][1]);
    op = infix[0][2].toLowerCase();
    b = _num(infix[0][3]);
  }
  if (a === null || b === null) return null;
  if (!_isJustTheSum(text, matched)) return null;

  let value;
  switch (op) {
    case "+":
    case "plus":
      value = a + b;
      break;
    case "-":
    case "−":
    case "–":
    case "minus":
      value = a - b;
      break;
    case "*":
    case "×":
    case "x":
    case "times":
      value = a * b;
      break;
    case "/":
    case "÷":
    case "divided by":
      // A division that does not come out exactly is not a captcha answer;
      // whatever this text is, it is not the sum it looks like.
      if (b === 0 || a % b !== 0) return null;
      value = a / b;
      break;
    default:
      return null;
  }

  // A negative answer is possible arithmetic and an implausible captcha, so it
  // is far more likely the text was misread. Refuse rather than submit one.
  if (!Number.isInteger(value) || value < 0) return null;
  return { answer: String(value), how: `arithmetic: ${matched.trim()}` };
}

/**
 * "How many letters are in the word CAT?"
 * @param {string} text
 * @returns {{answer: string, how: string}|null}
 */
function _letterCount(text) {
  const hits = [
    ...text.matchAll(
      /how many (letters|characters)\s+(?:are\s+)?(?:there\s+)?(?:in|does)\s+(?:the\s+word\s+)?["'“”‘’]?([A-Za-z]+)["'“”‘’]?/gi,
    ),
  ];
  if (hits.length !== 1) return null;
  const word = hits[0][2];
  // "how many letters in the answer" and friends: a word that is itself part
  // of the question is not the word being counted.
  if (/^(the|this|it|that|below|above|word|answer|total)$/i.test(word)) {
    return null;
  }
  return {
    answer: String(word.length),
    how: `letter count of "${word}"`,
  };
}

/**
 * "Type the third word of this sentence", "Enter the second word in
 * 'red green blue'".
 * @param {string} text
 * @returns {{answer: string, how: string}|null}
 */
function _nthWord(text) {
  const ord = Object.keys(ORDINALS).join("|");
  const hits = [
    ...text.matchAll(
      new RegExp(
        `\\b(${ord}|last)\\s+word\\s+(?:of|in|from)\\s+(this (?:sentence|question|line)|["'“”‘’][^"'“”‘’]+["'“”‘’])`,
        "gi",
      ),
    ),
  ];
  if (hits.length !== 1) return null;

  const which = hits[0][1].toLowerCase();
  const source = hits[0][2];
  // "this sentence" means the challenge itself — the words the user is
  // reading, punctuation stripped, in the order they appear.
  const phrase = /^this /i.test(source)
    ? text
    : source.replace(/^["'“”‘’]|["'“”‘’]$/g, "");
  const words = phrase
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);
  if (words.length === 0) return null;

  const index = which === "last" ? words.length : ORDINALS[which];
  // A sentence shorter than the position it names was not read correctly.
  if (index > words.length) return null;
  return {
    answer: words[index - 1],
    how: `${which} word of ${/^this /i.test(source) ? "the question" : "the quoted phrase"}`,
  };
}

const PARSERS = Object.freeze([_arithmetic, _letterCount, _nthWord]);

/**
 * Answer a written challenge, or say nothing.
 *
 * @param {string} raw - the challenge as the page renders it
 * @returns {{answer: string, how: string}|null} null whenever the text is not
 *   understood with certainty, which the caller must treat as "pause and ask".
 */
export function solveLocalChallenge(raw) {
  const text = _normalize(raw);
  if (!text || text.length > 300) return null;

  const answers = [];
  for (const parse of PARSERS) {
    const got = parse(text);
    if (got) answers.push(got);
  }
  // Two readings of one sentence is not certainty, however plausible each is.
  if (answers.length !== 1) return null;
  return answers[0];
}

// === END captcha-solvers.js ===
