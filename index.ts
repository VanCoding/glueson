import { runInNewContext } from "vm";
import type { Readable } from "stream";
import { createHash } from "crypto";
import { $ } from "bun";
import { readFile } from "fs/promises";

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
  stdin?: string;
  output?: Output;
};
type GetExpression = {
  _glueson: "get";
  path: string;
  input: any;
};

const Outputs = ["string", "json", "glueson"] as const;
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
    if (expression.stdin !== undefined && typeof expression.stdin !== "string")
      throw new Error("stdin must be a string");
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
      output: expression.output ?? "string",
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
  console.log("running code", code);
  const result = await runInNewContext("(async ()=>(" + code + "))()", params);
  return result;
};

const executeExcecuteExpression = async (expression: ExecuteExpression) => {
  const { command, params = {}, stdin = "" } = expression;

  const output = await executeEvaluateExpression({
    _glueson: "evaluate",
    code: "await $`" + command + (stdin ? " < ${stdin}" : "") + "`.text()",
    params: {
      $,
      stdin: Buffer.from(stdin, "utf8"),
      ...params,
    },
  });
  if (expression.output === "string") {
    return output;
  }
  const jsonOutput = JSON.parse(output);
  if (expression.output === "json") {
    return jsonOutput;
  }
  return await resolveGlueson(jsonOutput);
};

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

const inputFile = process.argv[2];

const input = !!inputFile
  ? await readFile(inputFile, "utf8")
  : await readStreamToEnd(process.stdin);

console.log(await resolveGlueson(JSON.parse(input)));
