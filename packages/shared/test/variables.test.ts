import { describe, expect, test } from "bun:test";
import {
  blankValues,
  checkEnvText,
  checkRows,
  formFromText,
  looksLikeEnvFile,
  mergePaste,
  parseEnv,
  publicSecretWarnings,
  resolveVariables,
  textFromRows,
  VARIABLES_MAX_BYTES,
  writeVariableLine,
} from "../src/variables.ts";

const ENV_WITH_COMMENTS = [
  "# Database",
  "DATABASE_URL=postgres://u:p@db:5432/app",
  "",
  "  # indented comment, kept as is",
  'GREETING="  hello world  "',
  "EMPTY=",
  "QUOTED='say \"hi\"'",
  "HASH=abc#def",
  "# trailing comment",
  "",
].join("\r\n");

describe("parsing env text (spec 05 5.5)", () => {
  test("reads names and values, with quotes taken literally", () => {
    const document = parseEnv(ENV_WITH_COMMENTS);
    expect(document.errors).toEqual([]);
    expect(document.newline).toBe("\r\n");
    expect(document.variables.map(({ name, value }) => [name, value])).toEqual([
      ["DATABASE_URL", "postgres://u:p@db:5432/app"],
      ["GREETING", "  hello world  "],
      ["EMPTY", ""],
      ["QUOTED", 'say "hi"'],
      ["HASH", "abc#def"],
    ]);
  });

  test("names start with a letter or _, then letters, digits, _, . or -", () => {
    expect(parseEnv("_a.b-c=1\nA1=2").errors).toEqual([]);
    const bad = parseEnv("1ABC=x\nA B=y");
    expect(bad.errors.map((error) => error.line)).toEqual([1, 2]);
    expect(bad.errors[0]?.message).toContain('"1ABC" isn\'t a valid name');
  });

  test("every blocking error names its line, in the spec's cases", () => {
    const text = [
      "JUST TEXT", // not NAME=value
      "=value", // value with no name
      "A=1",
      "A=2", // set twice
      'KEY="-----BEGIN', // a value over several lines
      "middle",
      '-----END"',
      "Q=a\"b'c`d", // all three quotes
      "OK=fine",
    ].join("\n");
    const { errors } = parseEnv(text);
    expect(errors.map((error) => [error.line, error.message])).toEqual([
      [
        1,
        "Line 1 isn't NAME=value. Write it as NAME=value, or start it with # to make it a comment.",
      ],
      [2, "Line 2 has a value but no name. Write it as NAME=value."],
      [4, "A is set twice, on lines 3 and 4. Keep one."],
      [
        5,
        "Line 5: the value of KEY goes over several lines (lines 5 to 7). Values must fit on one line.",
      ],
      [
        8,
        "Line 8: the value of Q contains all three quote characters (\" ' `), so it can't be written safely. Remove one kind of quote.",
      ],
    ]);
  });

  test("export and text after a closing quote are refused with a hint", () => {
    const { errors } = parseEnv('export A=1\nB="x" # note');
    expect(errors[0]?.message).toContain('without "export"');
    expect(errors[1]?.message).toContain("text after the closing quote");
  });

  test("text over 256 KB is refused", () => {
    const big = `A=${"x".repeat(VARIABLES_MAX_BYTES)}`;
    expect(checkEnvText(big)[0]?.message).toContain("256 KB");
    expect(checkEnvText("A=1")).toEqual([]);
  });
});

describe("tolerant reading, for env files written for other tools", () => {
  const pairs = (text: string) =>
    parseEnv(text, { tolerant: true }).variables.map(({ name, value }) => [name, value]);

  test("export prefixes and comments after a closing quote are read", () => {
    const document = parseEnv("export A=1\nexport\tB=\"x\" # note\nC='y'   # another", {
      tolerant: true,
    });
    expect(document.errors).toEqual([]);
    expect(document.variables.map(({ name, value }) => [name, value])).toEqual([
      ["A", "1"],
      ["B", "x"],
      ["C", "y"],
    ]);
  });

  test("a quoted value over several lines is one variable, and its inner lines aren't names", () => {
    const text = [
      "FIRST=1",
      'KEY="-----BEGIN',
      "NOT_A_NAME=abc",
      '-----END" # the key',
      "LAST=2",
    ].join("\r\n");
    const document = parseEnv(text, { tolerant: true });
    expect(document.errors).toEqual([]);
    expect(document.variables.map(({ name, value }) => [name, value])).toEqual([
      ["FIRST", "1"],
      ["KEY", "-----BEGIN\nNOT_A_NAME=abc\n-----END"],
      ["LAST", "2"],
    ]);
    const key = document.variables[1];
    expect([key?.line, key?.endLine]).toEqual([2, 4]);
    expect(key?.raw).toBe('KEY="-----BEGIN\r\nNOT_A_NAME=abc\r\n-----END" # the key');
  });

  test("a quote that never closes is read as written, and the lines after it on their own", () => {
    expect(pairs('A="open\nB=2\nC=3')).toEqual([
      ["A", '"open'],
      ["B", "2"],
      ["C", "3"],
    ]);
  });

  test("values with all three quotes or a stray carriage return are taken as they are", () => {
    expect(pairs("Q=a\"b'c`d\nR=x\ry")).toEqual([
      ["Q", "a\"b'c`d"],
      ["R", "x\ry"],
    ]);
  });

  test("lines that still aren't NAME=value are skipped with their errors, and twice-set names reported", () => {
    const document = parseEnv("JUST TEXT\n=value\n1BAD=x\nexport\nA=1\nA=2\nB=3", {
      tolerant: true,
    });
    expect(document.variables.map((variable) => variable.name)).toEqual(["A", "A", "B"]);
    expect(document.errors.map((error) => error.line)).toEqual([1, 2, 3, 4, 6]);
    expect(document.lines.filter((line) => line.kind === "invalid")).toHaveLength(4);
  });

  test("the strict reading is unchanged by default", () => {
    const text = 'export A=1\nB="x" # note\nKEY="multi\nline"';
    expect(parseEnv(text).variables).toEqual([]);
    expect(parseEnv(text).errors).toHaveLength(3);
    expect(parseEnv(text, { tolerant: false }).errors).toHaveLength(3);
  });
});

describe("the form keeps text exactly", () => {
  test("an env file with comments survives a round trip through the form byte for byte", () => {
    const form = formFromText(ENV_WITH_COMMENTS);
    expect(form.problem).toBeNull();
    expect(form.rows[0]?.above).toEqual(["# Database"]);
    expect(form.rows[1]?.above).toEqual(["", "  # indented comment, kept as is"]);
    expect(form.trailing).toEqual(["# trailing comment"]);
    const rows = form.rows.map(({ name, value }) => ({ name, value }));
    expect(textFromRows(ENV_WITH_COMMENTS, rows)).toBe(ENV_WITH_COMMENTS);
  });

  test("changing one row rewrites only that line; new rows use the text's line ending", () => {
    const original = "# keep me\nA=1\nB='two'\n";
    const next = textFromRows(original, [
      { name: "A", value: "1" },
      { name: "B", value: " spaced " },
      { name: "C", value: 'has "double"' },
    ]);
    expect(next).toBe('# keep me\nA=1\nB=" spaced "\nC=has "double"\n');
    expect(parseEnv(next).variables.map((v) => v.value)).toEqual(["1", " spaced ", 'has "double"']);
  });

  test("comments above a removed row stay, above the next row", () => {
    const original = "# about A\nA=1\n# about B\nB=2\n";
    expect(textFromRows(original, [{ name: "B", value: "2" }])).toBe("# about A\n# about B\nB=2\n");
    expect(textFromRows(original, [])).toBe("# about A\n# about B\n");
  });

  test("text the form can't hold opens as text with the reason", () => {
    const form = formFromText("A=1\nA=2");
    expect(form.problem).toStartWith("This opens as .env text, so nothing is changed or lost.");
    expect(form.problem).toContain("A is set twice");
  });

  test("written lines read back as the same value", () => {
    for (const value of ["", "plain", " lead", "trail ", '"quoted"', "it's", 'a`b"c', "#x"]) {
      const line = writeVariableLine("V", value);
      expect(parseEnv(line).variables[0]?.value).toBe(value);
    }
  });

  test("rows are checked with the row named", () => {
    const problems = checkRows([
      { name: "A", value: "1" },
      { name: "A", value: "2" },
      { name: "", value: "orphan" },
      { name: "9X", value: "" },
      { name: "M", value: "two\nlines" },
      { name: "Q", value: "\"'`" },
    ]);
    expect(problems.map((problem) => problem.line)).toEqual([2, 3, 4, 5, 6]);
    expect(problems[0]?.message).toBe("A is set twice, in rows 1 and 2. Keep one.");
  });

  test("copies get the names with empty values, comments kept", () => {
    expect(blankValues("# db\nDB=secret\nX='y'\n")).toBe("# db\nDB=\nX=\n");
  });
});

describe("pasting an env file", () => {
  test("adds and updates rows with the spec's summaries", () => {
    const result = mergePaste(
      [
        { name: "A", value: "old" },
        { name: "KEEP", value: "k" },
      ],
      "# comment\nA=new\nB=2\nnot a line\nC=3\n=bad\n",
    );
    expect(result.rows).toEqual([
      { name: "A", value: "new" },
      { name: "KEEP", value: "k" },
      { name: "B", value: "2" },
      { name: "C", value: "3" },
    ]);
    expect(result.messages).toEqual([
      "Added 2 variables and updated 1 from the paste.",
      "Left out lines 4 and 6: not one-line NAME=value.",
      "Comments in the paste were left out.",
    ]);
  });

  test("tells a pasted env file from a pasted value", () => {
    expect(looksLikeEnvFile("A=1\nB=2")).toBe(true);
    expect(looksLikeEnvFile("DATABASE_URL=postgres://x")).toBe(true);
    expect(looksLikeEnvFile("dGVzdA==")).toBe(false);
    expect(looksLikeEnvFile("postgres://user:pass@host/db?x=1")).toBe(false);
  });
});

describe("secret-looking names with a public prefix", () => {
  test("warn for secrets, not for ordinary public settings", () => {
    const warnings = publicSecretWarnings([
      "NEXT_PUBLIC_API_KEY",
      "VITE_SECRET",
      "NEXT_PUBLIC_SITE_URL",
      "REACT_APP_AUTH_TOKEN",
      "SECRET_KEY",
    ]);
    expect(warnings.map((warning) => warning.name)).toEqual([
      "NEXT_PUBLIC_API_KEY",
      "VITE_SECRET",
      "REACT_APP_AUTH_TOKEN",
    ]);
    expect(warnings[0]?.message).toContain("reach browsers");
  });
});

describe("how values reach a service (spec 05 5.5)", () => {
  test("own variables win over shared ones", () => {
    const result = resolveVariables({
      shared: [
        { name: "API_URL", value: "https://shared" },
        { name: "REGION", value: "eu" },
      ],
      own: [{ name: "API_URL", value: "https://own" }],
      target: "runtime",
    });
    expect(result).toEqual({
      ok: true,
      variables: [
        { name: "API_URL", value: "https://own" },
        { name: "REGION", value: "eu" },
      ],
    });
  });

  test("references to shared and own variables are replaced", () => {
    const result = resolveVariables({
      shared: [
        { name: "HOST", value: "db.internal" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference, not a template
        { name: "URL", value: "postgres://${{ environment.HOST }}:5432" },
      ],
      own: [
        { name: "PASSWORD", value: "pw" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference, not a template
        { name: "DSN", value: "${{environment.URL}}?password=${{PASSWORD}}" },
      ],
      target: "runtime",
    });
    expect(result.ok && result.variables.find((v) => v.name === "DSN")?.value).toBe(
      "postgres://db.internal:5432?password=pw",
    );
  });

  test("an unknown reference fails with its name", () => {
    const result = resolveVariables({
      shared: [],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference, not a template
      own: [{ name: "X", value: "${{environment.MISSING}}" }],
      target: "runtime",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.reference).toBe("environment.MISSING");
    expect(result.errors[0]?.message).toContain("MISSING");
  });

  test("loops fail instead of hanging", () => {
    const result = resolveVariables({
      shared: [],
      own: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference, not a template
        { name: "A", value: "${{B}}" },
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference, not a template
        { name: "B", value: "${{A}}" },
      ],
      target: "runtime",
    });
    expect(result.ok).toBe(false);
  });

  test("references that repeat each other can't grow without end (B1-08)", () => {
    // The report's attack: about 400 bytes that would double 16 times (13 MB), or 30 times.
    const own = [{ name: "V0", value: "x".repeat(200) }];
    for (let index = 1; index <= 30; index++) {
      own.push({ name: `V${index}`, value: `\${{V${index - 1}}}\${{V${index - 1}}}` });
    }
    const started = Date.now();
    const result = resolveVariables({ shared: [], own, target: "runtime" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.name).toBe("V11");
    expect(result.errors[0]?.message).toContain("grows past 256 KB");
    // Many values under the limit can't add up past the total either.
    const big = [{ name: "B", value: "y".repeat(200_000) }];
    for (let index = 0; index < 10; index++) big.push({ name: `C${index}`, value: `\${{B}}` });
    const many = resolveVariables({ shared: [], own: big, target: "runtime" });
    expect(many.ok).toBe(false);
    if (many.ok) return;
    expect(many.errors.map((error) => error.message).join(" ")).toContain(
      "add up to more than 1 MB",
    );
    // Ordinary references are untouched.
    const fine = resolveVariables({
      shared: [],
      own: [
        { name: "A", value: "a".repeat(100_000) },
        { name: "B", value: `\${{A}}` },
      ],
      target: "runtime",
    });
    expect(fine.ok).toBe(true);
  });

  test("0.1.x references: project.NAME is the shared NAME, and shared values keep what can't be worked out (R2-16)", () => {
    const moved = resolveVariables({
      shared: [
        { name: "API_URL", value: "https://api.example.com" },
        // Passed on as written by 0.1.x: a reference to nothing stays literal.
        { name: "TEMPLATE", value: `hello \${{ NOBODY }} and \${{environment.GONE}}` },
        { name: "LOOP_A", value: `\${{environment.LOOP_B}}` },
        { name: "LOOP_B", value: `\${{environment.LOOP_A}}` },
      ],
      own: [{ name: "BACKEND", value: `\${{project.API_URL}}/v1` }],
      target: "runtime",
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const value = (name: string) => moved.variables.find((item) => item.name === name)?.value;
    expect(value("BACKEND")).toBe("https://api.example.com/v1");
    expect(value("TEMPLATE")).toBe(`hello \${{ NOBODY }} and \${{environment.GONE}}`);
    expect(value("LOOP_B")).toBe(`\${{environment.LOOP_A}}`);
    // A variable literally named project.X still wins, and an unknown project.X names itself.
    const literal = resolveVariables({
      shared: [{ name: "X", value: "shared" }],
      own: [
        { name: "project.X", value: "own" },
        { name: "Y", value: `\${{project.X}}` },
      ],
      target: "runtime",
    });
    expect(literal.ok && literal.variables.find((item) => item.name === "Y")?.value).toBe("own");
    const unknown = resolveVariables({
      shared: [],
      own: [{ name: "Y", value: `\${{project.MISSING}}` }],
      target: "runtime",
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.errors[0]?.reference).toBe("project.MISSING");
    // A service's own value still fails on an unknown reference.
    const own = resolveVariables({
      shared: [],
      own: [{ name: "Z", value: `\${{environment.MISSING}}` }],
      target: "runtime",
    });
    expect(own.ok).toBe(false);
  });

  test("builds receive only names of letters, digits and _", () => {
    const result = resolveVariables({
      shared: [{ name: "app.mode", value: "x" }],
      own: [
        { name: "NODE_ENV", value: "production" },
        { name: "my-flag", value: "1" },
      ],
      target: "build",
    });
    expect(result.ok && result.variables.map((v) => v.name)).toEqual(["NODE_ENV"]);
  });

  test("Compose never inherits Docker or Compose control variables from shared ones", () => {
    const result = resolveVariables({
      shared: [
        { name: "DOCKER_HOST", value: "tcp://evil" },
        { name: "COMPOSE_PROJECT_NAME", value: "x" },
        { name: "PATH", value: "/tmp" },
        { name: "HOME", value: "/tmp" },
        { name: "LOG_LEVEL", value: "info" },
      ],
      own: [{ name: "COMPOSE_PROFILES", value: "web" }],
      target: "runtime",
      compose: true,
    });
    expect(result.ok && result.variables.map((v) => v.name)).toEqual([
      "LOG_LEVEL",
      "COMPOSE_PROFILES",
    ]);
  });
});
