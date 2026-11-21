/**
 * A small, safe formula evaluator for graphs. It reads what students write: the
 * variables x and y, + - * / ^, parentheses, common functions, and the
 * constants pi and e. Multiplication can be written with * or by putting things
 * side by side (2x, 3(x+1), (x+1)(x-1)). It never runs arbitrary code.
 */

/** A formula as a function of x and y. It gives NaN or Infinity where it is undefined. */
export type Formula = (x: number, y: number) => number;

type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "symbol"; value: string }; // + - * / ^ ( )

const FUNCTIONS: Record<string, (n: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sec: (n) => 1 / Math.cos(n),
  csc: (n) => 1 / Math.sin(n),
  cot: (n) => 1 / Math.tan(n),
  exp: Math.exp,
  ln: Math.log, // natural log
  log: Math.log10, // base 10, as in school maths
  log10: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  sign: Math.sign,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };
const VARIABLES = new Set(["x", "y"]);
const MAX_LENGTH = 500;

// Characters that show up in typed or recognized maths, mapped to what we parse.
const LOOKALIKES: Record<string, string> = {
  "−": "-",
  "–": "-",
  "×": "*",
  "·": "*",
  "÷": "/",
  π: "pi",
};

function tokenize(source: string): Token[] {
  if (source.length > MAX_LENGTH) throw new Error("The formula is too long.");

  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const raw = source[i];
    if (/\s/.test(raw)) {
      i++;
      continue;
    }

    const ch = Object.hasOwn(LOOKALIKES, raw) ? LOOKALIKES[raw] : raw;
    if (ch === "pi") {
      tokens.push({ kind: "name", value: "pi" });
      i++;
      continue;
    }

    const rest = source.slice(i);

    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }

    const name = /^[A-Za-z]+/.exec(rest);
    if (name) {
      const word = name[0].toLowerCase();
      const known =
        Object.hasOwn(FUNCTIONS, word) || Object.hasOwn(CONSTANTS, word) || VARIABLES.has(word);
      if (!known && [...word].every((letter) => VARIABLES.has(letter))) {
        // "xy" means x times y.
        for (const letter of word) tokens.push({ kind: "name", value: letter });
      } else {
        tokens.push({ kind: "name", value: word });
      }
      i += name[0].length;
      continue;
    }

    if (ch === "*" && source[i + 1] === "*") {
      tokens.push({ kind: "symbol", value: "^" }); // ** is also "to the power of"
      i += 2;
      continue;
    }
    if ("+-*/^()".includes(ch)) {
      tokens.push({ kind: "symbol", value: ch });
      i++;
      continue;
    }

    throw new Error(`Unexpected "${raw}" in the formula.`);
  }
  return tokens;
}

/** Turn a formula like `x^2 - 3x + 2` into a function. Throws an Error if it can't be read. */
export function compileFormula(source: string): Formula {
  const tokens = tokenize(source);
  let pos = 0;

  const fail = (message: string): never => {
    throw new Error(message);
  };
  const isSymbol = (value: string) => {
    const token = tokens[pos];
    return token?.kind === "symbol" && token.value === value;
  };
  const expectClose = () => {
    if (!isSymbol(")")) fail("A bracket is not closed.");
    pos++;
  };
  // Does the next token begin a new factor? Then a missing operator means "times".
  const startsFactor = () => {
    const token = tokens[pos];
    return token?.kind === "number" || token?.kind === "name" || isSymbol("(");
  };

  // sum := product (("+" | "-") product)*
  const sum = (): Formula => {
    let left = product();
    while (isSymbol("+") || isSymbol("-")) {
      const plus = isSymbol("+");
      pos++;
      const l = left;
      const r = product();
      left = plus ? (x, y) => l(x, y) + r(x, y) : (x, y) => l(x, y) - r(x, y);
    }
    return left;
  };

  // product := unary (("*" | "/")? unary)*
  const product = (): Formula => {
    let left = unary();
    for (;;) {
      let divide = false;
      if (isSymbol("*")) pos++;
      else if (isSymbol("/")) {
        divide = true;
        pos++;
      } else if (!startsFactor()) break;

      const l = left;
      const r = unary();
      left = divide ? (x, y) => l(x, y) / r(x, y) : (x, y) => l(x, y) * r(x, y);
    }
    return left;
  };

  // unary := ("-" | "+") unary | power
  const unary = (): Formula => {
    if (isSymbol("-")) {
      pos++;
      const inner = unary();
      return (x, y) => -inner(x, y);
    }
    if (isSymbol("+")) {
      pos++;
      return unary();
    }
    return power();
  };

  // power := primary ("^" unary)?   (right to left, so x^2^3 is x^(2^3), and -x^2 is -(x^2))
  const power = (): Formula => {
    const base = primary();
    if (isSymbol("^")) {
      pos++;
      const exponent = unary();
      return (x, y) => Math.pow(base(x, y), exponent(x, y));
    }
    return base;
  };

  const primary = (): Formula => {
    const token = tokens[pos];
    if (!token) return fail("The formula ends too soon.");

    if (token.kind === "number") {
      pos++;
      const value = token.value;
      return () => value;
    }

    if (token.kind === "name") {
      pos++;
      const name = token.value;
      if (Object.hasOwn(FUNCTIONS, name) && isSymbol("(")) {
        pos++;
        const apply = FUNCTIONS[name];
        const argument = sum();
        expectClose();
        return (x, y) => apply(argument(x, y));
      }
      if (name === "x") return (x) => x;
      if (name === "y") return (_x, y) => y;
      if (Object.hasOwn(CONSTANTS, name)) {
        const value = CONSTANTS[name];
        return () => value;
      }
      return fail(`Don't know "${name}". Functions need brackets, like sin(x).`);
    }

    if (token.value === "(") {
      pos++;
      const inner = sum();
      expectClose();
      return inner;
    }

    return fail(`Unexpected "${token.value}" in the formula.`);
  };

  const formula = sum();
  if (pos < tokens.length) fail("Something is left over at the end of the formula.");
  return formula;
}

/** Does the formula mention this variable? False if it can't be read at all. */
export function usesVariable(source: string, name: "x" | "y"): boolean {
  try {
    return tokenize(source).some((token) => token.kind === "name" && token.value === name);
  } catch {
    return false;
  }
}

/** Like `compileFormula`, but gives null instead of throwing. */
export function tryCompileFormula(source: string): Formula | null {
  try {
    return compileFormula(source);
  } catch {
    return null;
  }
}
