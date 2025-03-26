import { runInNewContext } from "vm";
import type { Readable } from "stream";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { parseArgs } from "util";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

type GluesonBase = string | number | boolean;
type Glueson = GluesonBase | Array<Glueson> | { [key: string]: Glueson };

type EvaluateExpression = {
  _glueson: "evaluate";
  code: string;
  params?: Record<string, any>;
};

type ExecuteExpression = {
  _glueson: "execute";
  command: string;
  params?: Record<string, any>;
  stdin?: any;
  stdinFormat?: "text" | "json";
  output?: Output;
};
type GetExpression = {
  _glueson: "get";
  path: string;
  input: any;
};

const Outputs = ["text", "json", "glueson", "log"] as const;
type Output = (typeof Outputs)[number];

type GluesonExpression = EvaluateExpression | ExecuteExpression | GetExpression;

type Operation = GluesonExpression["_glueson"];

const parsers: Record<
  Operation,
  (expression: Record<string, any>) => GluesonExpression
> = {
  evaluate: (expression) => {
    if (typeof expression.code !== "string")
      throw new Error("code is required");
    if (
      expression.params !== undefined &&
      typeof expression.params !== "object"
    )
      throw new Error("params must be an object");
    return {
      _glueson: "evaluate",
      code: expression.code,
      params: expression.params as Record<string, any>,
    };
  },
  execute: (expression) => {
    if (typeof expression.command !== "string")
      throw new Error(`command is required`);
    if (
      expression.params !== undefined &&
      typeof expression.params !== "object"
    )
      throw new Error("params must be an object");
    if (
      expression.output !== undefined &&
      !Outputs.includes(expression.output)
    ) {
      throw new Error(`invalid output type ${expression.output}`);
    }
    return {
      _glueson: "execute",
      command: expression.command,
      params: expression.params,
      stdin: expression.stdin,
      output: expression.output ?? "text",
    };
  },
  get: (expression) => {
    if (typeof expression.path !== "string")
      throw new Error("path is required");
    if (typeof expression.input !== "object")
      throw new Error("input must be an object");
    return {
      _glueson: "get",
      input: expression.input,
      path: expression.path,
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
  if (typeof glueson !== "object") return false;
  return "_glueson" in glueson;
};

const parseExpression = (expression: {
  _glueson: Operation;
}): GluesonExpression => {
  return parsers[expression._glueson](expression);
};

const cache = new Map<string, Promise<ResolvedGlueson>>();

export const resolveGlueson = async (
  glueson: Glueson
): Promise<ResolvedGlueson> => {
  if (isBaseType(glueson)) {
    return glueson;
  } else if (Array.isArray(glueson)) {
    return await Promise.all(
      glueson.map(async (item) => await resolveGlueson(item))
    );
  } else {
    const value = Object.fromEntries(
      await Promise.all(
        Object.entries(glueson).map(async ([key, value]) => {
          return [key, await resolveGlueson(value)];
        })
      )
    );
    if (isExpression(value)) {
      const expression = parseExpression(value);
      const hash = hashExpression(expression);
      const cachedValue = cache.get(hash);
      if (cachedValue) {
        return await cachedValue;
      }
      const result = executeGluesonExpression(expression);
      cache.set(hash, result);
      return await result;
    } else {
      return value;
    }
  }
};

const hashExpression = (expression: GluesonExpression) => {
  return createHash("sha256").update(JSON.stringify(expression)).digest("hex");
};

const executeGluesonExpression = (expression: GluesonExpression) => {
  if (expression._glueson === "evaluate") {
    return executeEvaluateExpression(expression);
  } else if (expression._glueson === "execute") {
    return executeExcecuteExpression(expression);
  } else {
    return executeGetExpression(expression);
  }
};

const executeEvaluateExpression = async (expression: EvaluateExpression) => {
  const { code, params = {} } = expression;
  const result = await runInNewContext("(async ()=>(" + code + "))()", params);
  return result;
};

const executeExcecuteExpression = async (expression: ExecuteExpression) => {
  const {
    command,
    params = {},
    stdin = "",
    stdinFormat = typeof stdin === "string" ? "text" : "json",
  } = expression;

  const result = await runCommand(
    command,
    params,
    stdinFormat === "text" ? stdin : JSON.stringify(stdin),
    expression.output === "log"
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
  if (expression.output === "log") {
    return result.exitCode;
  }

  if (expression.output === "text") {
    return result.stdout;
  }
  const jsonOutput = JSON.parse(result.stdout);
  if (expression.output === "json") {
    return jsonOutput;
  }
  return await resolveGlueson(jsonOutput);
};

const runCommand = (
  command: string,
  inputs: Record<string, string | string[]>,
  stdin: string,
  log: boolean
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
      p = spawn(executable, args);
    } catch {
      resolve(`executable ${executable} not found`);
      return;
    }
    p.stdin.end(stdin);
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
  args: Bun.argv,
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
