/**
 * Default filler words database for auto-edit functionality
 * Used by n8n orchestration to detect and remove filler words from transcriptions
 *
 * Usage in n8n:
 * 1. Extract audio with /api/extract-audio
 * 2. Transcribe with Whisper (word-level timestamps)
 * 3. Match transcription against these filler words
 * 4. Create segments excluding filler words
 * 5. Assemble with /api/auto-edit (segments parameter)
 */

const fillerWords = {
  // French filler words
  fr: [
    'euh',
    'ah',
    'donc',
    'du coup',
    'en fait',
    'tu sais',
    'genre',
    'quoi',
    'ouais',
    'ben',
    'alors',
    'voilà',
    'bah',
    'hein',
    'bon',
    'enfin',
    'bref',
    'tu vois',
    'comment dire',
    'disons que',
    'en gros',
    'effectivement'
  ],

  // English filler words
  en: [
    'uh',
    'um',
    'ah',
    'like',
    'you know',
    'actually',
    'basically',
    'essentially',
    'literally',
    'honestly',
    'right',
    'so',
    'well',
    'I mean',
    'kind of',
    'sort of',
    'you see',
    'anyway',
    'whatever',
    'just'
  ],

  // Spanish filler words
  es: [
    'eh',
    'uh',
    'este',
    'pues',
    'entonces',
    'la verdad',
    'o sea',
    'bueno',
    'mira',
    'sabes',
    'tipo',
    'como que',
    'digamos',
    'básicamente',
    'en plan'
  ],

  // German filler words
  de: [
    'äh',
    'ähm',
    'also',
    'halt',
    'quasi',
    'sozusagen',
    'eigentlich',
    'irgendwie',
    'genau',
    'na ja',
    'weisst du',
    'und so'
  ],

  // Portuguese filler words
  pt: [
    'é',
    'tipo',
    'então',
    'né',
    'sabe',
    'assim',
    'basicamente',
    'na verdade',
    'olha',
    'bom',
    'enfim'
  ],

  // Italian filler words
  it: [
    'eh',
    'cioè',
    'allora',
    'praticamente',
    'tipo',
    'insomma',
    'diciamo',
    'sai',
    'ecco',
    'boh'
  ]
};

/**
 * Get filler words for a specific language
 * @param {string} lang - Language code (fr, en, es, de, pt, it)
 * @returns {Array} Array of filler words
 */
function getFillerWords(lang = 'en') {
  return fillerWords[lang.toLowerCase()] || fillerWords.en;
}

/**
 * Get all supported languages
 * @returns {Array} Array of language codes
 */
function getSupportedLanguages() {
  return Object.keys(fillerWords);
}

/**
 * Check if a word/phrase is a filler word
 * @param {string} word - Word to check
 * @param {string} lang - Language code
 * @returns {boolean} True if the word is a filler word
 */
function isFillerWord(word, lang = 'en') {
  const words = getFillerWords(lang);
  const normalized = word.toLowerCase().trim();
  return words.some(filler =>
    normalized === filler.toLowerCase() ||
    normalized.includes(filler.toLowerCase())
  );
}

/**
 * Find filler words in a transcription with timestamps
 * @param {Array} words - Array of word objects with {word, start, end}
 * @param {string} lang - Language code
 * @returns {Array} Array of filler word occurrences with timestamps
 */
function findFillerWordsInTranscription(words, lang = 'en') {
  const fillers = getFillerWords(lang);
  const found = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const normalized = word.word.toLowerCase().trim();

    // Check single words
    if (fillers.some(f => normalized === f.toLowerCase())) {
      found.push({
        word: word.word,
        start: word.start,
        end: word.end,
        type: 'single'
      });
      continue;
    }

    // Check two-word phrases (e.g., "you know", "du coup")
    if (i < words.length - 1) {
      const twoWords = `${normalized} ${words[i + 1].word.toLowerCase().trim()}`;
      const matchingPhrase = fillers.find(f => twoWords === f.toLowerCase());
      if (matchingPhrase) {
        found.push({
          word: matchingPhrase,
          start: word.start,
          end: words[i + 1].end,
          type: 'phrase'
        });
      }
    }
  }

  return found;
}

module.exports = {
  fillerWords,
  getFillerWords,
  getSupportedLanguages,
  isFillerWord,
  findFillerWordsInTranscription
};
