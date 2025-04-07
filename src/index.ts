import { runInNewContext } from "vm";
import type { Readable } from "stream";
import { readFile, writeFile } from "fs/promises";
import { rmSync } from "fs";
import { parseArgs } from "util";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { resolve } from "path";

type GluesonBase = string | number | boolean;
type Glueson = GluesonBase | Array<Glueson> | { [key: string]: Glueson };

type EvaluateExpression = {
  _glueson: "evaluate";
  code: string;
  params: Record<string, any>;
  lazy: boolean;
};

type SerializeExpression = {
  _glueson: "serialize";
  input: any;
};

type ParseExpression = {
  _glueson: "parse";
  input: string;
};

type ExecuteExpression = {
  _glueson: "execute";
  command: string;
  params: Record<string, any>;
  stdin: any;
  log: boolean;
  env: Record<string, string>;
};
type GetExpression = {
  _glueson: "get";
  path: string;
  input: any;
};

type TemporaryFileExpression = {
  _glueson: "temporary-file";
  content: string;
};

type GluesonExpression =
  | EvaluateExpression
  | ExecuteExpression
  | GetExpression
  | ParseExpression
  | SerializeExpression
  | TemporaryFileExpression;

type Operation = GluesonExpression["_glueson"];

const parsers: Record<
  Operation,
  (expression: Record<string, any>) => Promise<GluesonExpression>
> = {
  evaluate: async (expression) => {
    const code = await resolveGlueson(expression.code);
    if (typeof code !== "string") throw new Error("code must be a string");
    const lazy = await resolveGlueson(expression.lazy);
    if (lazy !== undefined && typeof lazy !== "boolean") {
      throw new Error("lazy must be a boolean");
    }
    const params = await resolveValue(expression.params);
    if (params !== undefined && typeof params !== "object")
      throw new Error("params must be an object");
    return {
      _glueson: "evaluate",
      code,
      params: params as Record<string, any>,
      lazy: lazy ?? false,
    };
  },
  execute: async (expression) => {
    const command = await resolveGlueson(expression.command);
    if (typeof command !== "string")
      throw new Error(`command must be a string`);
    const params = await resolveGlueson(expression.params);
    if (params !== undefined && typeof params !== "object")
      throw new Error("params must be an object");
    const stdin = await resolveGlueson(expression.stdin);
    const log = await resolveGlueson(expression.log);
    if (log !== undefined && typeof log !== "boolean") {
      throw new Error(`log must be a boolean`);
    }
    const env = await resolveGlueson(expression.env);
    if (env !== undefined) {
      if (typeof env !== "object") {
        throw new Error(`env must be an object`);
      }
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") {
          throw new Error(`env values must be strings (${key})`);
        }
      }
    }

    return {
      _glueson: "execute",
      command,
      params: params ?? {},
      stdin: stdin ?? "",
      log: log ?? false,
      env: (env as Record<string, string> | undefined) ?? {},
    };
  },
  get: async (expression) => {
    const path = await resolveGlueson(expression.path);
    if (typeof path !== "string") throw new Error("path is required");
    return {
      _glueson: "get",
      input: expression.input,
      path,
    };
  },
  parse: async (expression) => {
    const input = await resolveGlueson(expression.input);
    if (typeof input !== "string") {
      throw new Error("parse input must be a string");
    }
    return {
      _glueson: "parse",
      input,
    };
  },
  serialize: async (expression) => {
    const input = await resolveGlueson(expression.input);
    if (input === undefined) {
      throw new Error("serialize input must be defined");
    }
    return {
      _glueson: "serialize",
      input,
    };
  },
  "temporary-file": async (expression) => {
    const content = await resolveGlueson(expression.content);
    if (typeof content === "undefined")
      throw new Error("temp-file content must be defined");
    return {
      _glueson: "temporary-file",
      content: typeof content === "string" ? content : JSON.stringify(content),
    };
  },
};

type ResolvedGlueson =
  | GluesonBase
  | Array<ResolvedGlueson>
  | { [key: string]: ResolvedGlueson };

const isBaseType = (glueson: Glueson): glueson is GluesonBase => {
  const type = typeof glueson;
  return type === "string" || type === "number" || type === "boolean";
};

const isExpression = (glueson: Glueson): glueson is { _glueson: Operation } => {
  if (typeof glueson !== "object" || glueson === null) return false;
  return "_glueson" in glueson;
};

const parseExpression = async (expression: {
  _glueson: Operation;
}): Promise<GluesonExpression> => {
  return await parsers[expression._glueson](expression);
};

export const resolveGlueson = async (
  glueson: Glueson
): Promise<ResolvedGlueson> => {
  const resolved = await resolveValue(glueson);
  if (isBaseType(resolved) || resolved === null || resolved === undefined) {
    return resolved;
  } else if (Array.isArray(resolved)) {
    return await Promise.all(
      resolved.map(async (item) => await resolveGlueson(item))
    );
  } else {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(resolved).map(async ([key, value]) => {
          return [key, await resolveGlueson(value)];
        })
      )
    );
  }
};

const hashExpression = (expression: GluesonExpression) => {
  const sortProps = (value: any) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).sort((a, b) => (a[0] as string).localeCompare(b[0]))
    );
  };

  const content = JSON.stringify(sortProps(expression), (key, value) =>
    sortProps(value)
  );

  return createHash("sha256").update(content).digest("hex");
};

const cache = new Map<string, Promise<any>>();
const cached =
  <T extends GluesonExpression>(fn: (expression: T) => Promise<any>) =>
  (expression: T) => {
    const hash = hashExpression(expression);
    const cachedValue = cache.get(hash);
    if (cachedValue) {
      return cachedValue;
    }
    const result = fn(expression);
    cache.set(hash, result);
    return result;
  };

const tempFiles = new Set<string>();

const executeTemporaryFileExpression = async (
  expression: TemporaryFileExpression
): Promise<string> => {
  const hash = hashExpression(expression);
  const path = resolve(tmpdir(), `glueson-${new Date().getTime()}-${hash}`);
  await writeFile(path, expression.content);
  tempFiles.add(path);
  return path;
};

export const resolveValue = async (
  glueson: Glueson
): Promise<ResolvedGlueson> => {
  while (isExpression(glueson)) {
    const expression = await parseExpression(glueson);
    glueson = await executeGluesonExpression(expression);
  }

  return glueson;
};

const getValue = async (glueson: Glueson, path: string | number[] = []) => {
  let value = await resolveValue(glueson);
  for (const key of path) {
    if (typeof value !== "object")
      throw new Error(`cannot get property ${key} of non-object`);
    value = await resolveValue((value as Record<string | number, any>)[key]);
  }
  return value;
};

const executeGluesonExpression = (expression: GluesonExpression) => {
  if (expression._glueson === "evaluate") {
    return executeEvaluateExpression(expression);
  } else if (expression._glueson === "execute") {
    return executeExcecuteExpression(expression);
  } else if (expression._glueson === "get") {
    return executeGetExpression(expression);
  } else if (expression._glueson === "parse") {
    return executeParseExpression(expression);
  } else if (expression._glueson === "serialize") {
    return executeSerializeExpression(expression);
  } else if (expression._glueson === "temporary-file") {
    return executeTemporaryFileExpression(expression);
  }
  throw new Error(`unknown expression type`);
};

const executeEvaluateExpression = async (expression: EvaluateExpression) => {
  const { code, params, lazy } = expression;
  const result = await runInNewContext("(async ()=>(" + code + "))()", {
    ...(lazy
      ? params
      : ((await resolveGlueson(params)) as Record<string, any>)),
    env: process.env,
    get: getValue,
  });
  return result;
};

const executeParseExpression = async (expression: ParseExpression) => {
  return JSON.parse(expression.input);
};

const executeSerializeExpression = async (expression: SerializeExpression) => {
  return JSON.stringify(expression.input);
};

const executeExcecuteExpression = cached(
  async (expression: ExecuteExpression) => {
    const { command, params, stdin } = expression;

    const result = await runCommand(
      command,
      params,
      stdin,
      expression.log,
      expression.env
    );

    if (typeof result === "string") {
      console.error(result);
      process.exit(1);
    }
    if (result.exitCode !== 0) {
      console.error(
        `command "${command}" failed with exit code ${result.exitCode}\n`
      );

      if (Object.keys(params).length > 0) {
        console.error("params: ", JSON.stringify(params, null, 2), "\n");
      }
      if (stdin) {
        console.error(`stdin:\n${stdin}\n`);
      }
      if (result.stdout.length > 0) {
        console.error(`stdout:\n${result.stdout}\n`);
      }
      if (result.stderr.length > 0) {
        console.error(`stderr:\n${result.stderr}\n`);
      }
      process.exit(1);
    }
    if (expression.log) {
      return result.exitCode;
    }
    return result.stdout;
  }
);

const toJsonIfNotString = (value: any) => {
  return typeof value === "string" ? value : JSON.stringify(value);
};

const runCommand = (
  command: string,
  inputs: Record<string, string | string[]>,
  stdin: any,
  log: boolean,
  env: Record<string, string>
) => {
  return new Promise<
    | {
        exitCode: Number;
        stdout: string;
        stderr: string;
      }
    | string
  >((resolve) => {
    const [executable, ...args] = prepareArgs(command, inputs);
    if (!executable)
      throw new Error("command must consist of at least one character");
    let p: ChildProcessWithoutNullStreams;
    try {
      p = spawn(executable, args, {
        env: {
          ...process.env,
          ...env,
        },
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      console.error(e);
      resolve(`executable ${executable} not found`);
      return;
    }
    if (stdin) {
      p.stdin.end(toJsonIfNotString(stdin));
    }
    const stdout = readStreamToEnd(p.stdout);
    const stderr = readStreamToEnd(p.stderr);
    if (log) {
      p.stdout.pipe(process.stdout);
      p.stderr.pipe(process.stderr);
    }
    p.on("exit", async (exitCode) => {
      resolve({
        exitCode: exitCode!,
        stdout: await stdout,
        stderr: await stderr,
      });
    });
  });
};

const prepareArgs = (
  command: string,
  inputs: Record<string, string | string[]>
) =>
  command
    .split(" ")
    .filter((arg) => arg.length > 0)
    .flatMap((arg) => {
      if (arg.startsWith("$")) {
        const input = inputs[arg.slice(1)];
        if (input === undefined) throw new Error(`missing input ${arg}`);
        return typeof input === "object" ? input : [input];
      }
      return [arg];
    });

const executeGetExpression = async (expression: GetExpression) => {
  const { input, path } = expression;
  const properties = path.split(".");
  let result = input;
  for (const property of properties) {
    if (typeof result !== "object")
      throw new Error(`cannot get property ${property} of non-object`);
    result = result[property];
  }
  return result;
};

const readStreamToEnd = async (stream: Readable) => {
  stream.setEncoding("utf8");
  const allData: string[] = [];
  stream.on("data", (data) => {
    allData.push(data);
  });
  const output = await new Promise<string>((resolve, reject) => {
    stream.on("end", () => {
      resolve(allData.join(""));
    });
  });
  return output;
};

const removeShebang = (code: string) => {
  if (code.startsWith("#!")) {
    for (let i = 2; i < code.length; i++) {
      if (code[i] === "\n" || code[i] === "\r") return code.slice(i + 1);
    }
  }
  return code;
};

const args = parseArgs({
  args: process.argv,
  options: {
    output: { type: "string", short: "o", default: "json" },
  },
  allowPositionals: true,
});

const inputFile = args.positionals[2];

const input = !!inputFile
  ? await readFile(inputFile, "utf8")
  : await readStreamToEnd(process.stdin);

const result = await resolveGlueson(JSON.parse(removeShebang(input)));

console.log(
  args.values.output === "text" && typeof result === "string"
    ? result
    : JSON.stringify(result, null, 2)
);

process.on("exit", () => {
  for (const tempFile of tempFiles) {
    rmSync(tempFile, { force: true });
  }
});
