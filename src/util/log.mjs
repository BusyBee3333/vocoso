/** Timestamped, tagged console logging with a captured tail for reports. */

const TAIL_LIMIT = 4000;
const ESC = String.fromCharCode(27);

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `${ESC}[${code}m${text}${ESC}[0m` : text);

const LEVEL_STYLE = {
  info: (text) => text,
  step: (text) => paint("36", text),
  pass: (text) => paint("32", text),
  fail: (text) => paint("31", text),
  warn: (text) => paint("33", text),
  heal: (text) => paint("35", text),
  debug: (text) => paint("90", text),
};

export function createLogger({ verbose = false, quiet = false } = {}) {
  const tail = [];
  const emit = (level, tag, message) => {
    const entry = { at: Date.now(), level, tag, message: String(message) };
    tail.push(entry);
    if (tail.length > TAIL_LIMIT) tail.shift();
    if (quiet && level !== "fail") return entry;
    if (level === "debug" && !verbose) return entry;
    const stamp = new Date(entry.at).toISOString().slice(11, 19);
    const style = LEVEL_STYLE[level] ?? LEVEL_STYLE.info;
    console.log(`${paint("90", stamp)} ${style(`[${tag}]`)} ${entry.message}`);
    return entry;
  };

  return {
    tail,
    info: (tag, message) => emit("info", tag, message),
    step: (tag, message) => emit("step", tag, message),
    pass: (tag, message) => emit("pass", tag, message),
    fail: (tag, message) => emit("fail", tag, message),
    warn: (tag, message) => emit("warn", tag, message),
    heal: (tag, message) => emit("heal", tag, message),
    debug: (tag, message) => emit("debug", tag, message),
  };
}

/** A logger that records but never prints - for tests and embedded use. */
export const silentLogger = () => createLogger({ quiet: true });
