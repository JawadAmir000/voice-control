/** Instant, personal greetings, answered locally without waiting for Claude. */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();

const GREETING_WORDS = new Set(['hello', 'hi', 'hey', 'hiya', 'yo', 'greetings', 'howdy', 'morning', 'afternoon', 'evening', 'salam', 'assalamualaikum', 'salaam']);
const FILLER = new Set(['there', 'computer', 'assistant', 'buddy', 'friend', 'good', 'how', 'are', 'you', 'doing', "what's", 'whats', 'up', 'is', 'it', 'going', 'oh', 'well', 'so', 'ok', 'okay', 'again', 'my', 'dear', 'today', 'all', 'and', 'alaikum']);

/** "Hello", "Hi there", "Good morning computer", "Hello, how are you?" → true. "Hello, open Chrome" → false. */
export function isGreeting(text: string): boolean {
  const words = norm(text).split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 7) return false;
  return words.some((w) => GREETING_WORDS.has(w)) && words.every((w) => GREETING_WORDS.has(w) || FILLER.has(w));
}

function partOfDay(d: Date): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 22) return 'Good evening';
  return 'Hi';
}

const ABILITIES = [
  'open any app or website, write and type for you, manage your files and windows, and take care of tasks across your computer',
  'launch your apps, write emails and documents, organize your files, and handle the clicking and typing for you',
  'open programs and sites, draft and type text, find and tidy your files, and run whole tasks on your PC for you',
];
const ASKS = [
  'So, what would you like help with today?',
  'What can I do for you today?',
  'How can I help you today?',
];

/** "Good evening, Jawad! I'm your personal AI assistant. I can …. What can I do for you today?" */
export function greetingFor(name: string, now = new Date(), pick = Math.random()): string {
  const i = Math.floor(pick * ABILITIES.length) % ABILITIES.length;
  const hello = name ? `${partOfDay(now)}, ${name}!` : `${partOfDay(now)}!`;
  return `${hello} I'm your personal AI assistant. I can ${ABILITIES[i]}. ${ASKS[i]}`;
}
