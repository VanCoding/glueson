import { runInNewContext } from "vm";
import type { Readable } from "stream";
import { createHash, randomBytes } from "crypto";
import { readFile, unlink } from "fs/promises";
import { parseArgs } from "util";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  exec,
} from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createReadStream, createWriteStream, ReadStream } from "fs";

type GluesonBase = string | number | boolean;
type Glueson = GluesonBase | Array<Glueson> | { [key: string]: Glueson };

type EvaluateExpression = {
  _glueson: "evaluate";
  code: string;
  params?: Record<string, any>;
};

type SerializeExpression = {
  _glueson: "serialize";
  input: any;
};

type ParseExpression = {
  _glueson: "parse";
  format: "json" | "glueson";
  input: string;
};

type ExecuteExpression = {
  _glueson: "execute";
  command: string;
  params: Record<string, any>;
  stdin: any;
  streams: Record<string, any>;
  log: boolean;
};
type GetExpression = {
  _glueson: "get";
  path: string;
  input: any;
};

type GluesonExpression =
  | EvaluateExpression
  | ExecuteExpression
  | GetExpression
  | ParseExpression
  | SerializeExpression;

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
    if (expression.log !== undefined && typeof expression.log !== "boolean") {
      throw new Error(`log must be a boolean`);
    }
    if (
      expression.streams !== undefined &&
      typeof expression.streams !== "object"
    )
      throw new Error("streams must be an object");

    return {
      _glueson: "execute",
      command: expression.command,
      params: expression.params ?? {},
      stdin: expression.stdin ?? "",
      streams: expression.streams ?? {},
      log: expression.log ?? false,
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
  parse: (expression) => {
    if (
      expression.format !== undefined &&
      !["test", "json", "glueson"].includes(expression.format)
    ) {
      throw new Error(`parse format must be one of "text", "json", "glueson"`);
    }
    if (typeof expression.input !== "string") {
      throw new Error("parse input must be a string");
    }
    return {
      _glueson: "parse",
      format: expression.format ?? "json",
      input: expression.input,
    };
  },
  serialize: (expression) => {
    if (expression.input === undefined) {
      throw new Error("serialize input must be defined");
    }
    return {
      _glueson: "serialize",
      input: expression.input,
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
  } else if (expression._glueson === "get") {
    return executeGetExpression(expression);
  } else if (expression._glueson === "parse") {
    return executeParseExpression(expression);
  } else if (expression._glueson === "serialize") {
    return executeSerializeExpression(expression);
  }
  throw new Error(`unknown expression type`);
};

const executeEvaluateExpression = async (expression: EvaluateExpression) => {
  const { code, params = {} } = expression;
  const result = await runInNewContext("(async ()=>(" + code + "))()", params);
  return result;
};

const executeParseExpression = async (expression: ParseExpression) => {
  const result = JSON.parse(expression.input);
  if (expression.format === "glueson") {
    return await resolveGlueson(result);
  }
  return result;
};

const executeSerializeExpression = async (expression: SerializeExpression) => {
  return JSON.stringify(expression.input);
};

const executeExcecuteExpression = async (expression: ExecuteExpression) => {
  const { command, params, stdin, streams } = expression;

  const { streams: pipes, params: pipeParams } = await makePipes(streams);
  const result = await runCommand(
    command,
    { ...params, ...pipeParams },
    stdin,
    pipes,
    expression.log
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
};

const toJsonIfNotString = (value: any) => {
  return typeof value === "string" ? value : JSON.stringify(value);
};

const runCommand = (
  command: string,
  inputs: Record<string, string | string[]>,
  stdin: any,
  streams: ReadStream[],
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
      p = spawn(executable, args, {
        stdio: ["pipe", "pipe", "pipe", ...streams],
        env: process.env,
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

const makePipes = async (
  streams: Record<string, any>
): Promise<{ streams: ReadStream[]; params: Record<string, string> }> => {
  const pipes = await Promise.all(
    Object.entries(streams).map(async ([key, value], index) => {
      return {
        key,
        path: `/dev/fd/${index + 3}`,
        stream: await makePipe(value),
      };
    })
  );
  return {
    params: Object.fromEntries(pipes.map(({ key, path }) => [key, path])),
    streams: pipes.map(({ stream }) => stream),
  };
};

const makePipe = async (value: string) => {
  const path = makeTempPath();
  await execAsync(`mkfifo ${path}`);
  const writeStream = createWriteStream(path).once("open", async () => {
    writeStream.end(value);
    await unlink(path);
  });

  return await new Promise<ReadStream>((resolve) => {
    const readStream = createReadStream(path);
    readStream.on("open", () => {
      resolve(readStream);
    });
  });
};

const execAsync = (command: string) => {
  return new Promise<number>((resolve, reject) => {
    const p = exec(command);
    p.on("exit", async (code) => {
      if (code !== 0) {
        reject(new Error(`command "${command}" failed with exit code ${code}`));
      } else {
        resolve(code);
      }
    });
  });
};

const makeTempPath = () => {
  return join(
    tmpdir(),
    `archive.${randomBytes(6).readUIntLE(0, 6).toString(36)}`
  );
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
