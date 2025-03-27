# glueson

glueson is a JSON-based programming language. Glueson is a superset of JSON. All valid JSON code is also valid glueson code. In addition to static JSON, glueson allows for some values to be dynamic. Example:

```json
{
  "firstname": "John",
  "lastname": {
    "_glueson": "execute",
    "command": "echo 'Doe'"
  }
}
```

Evaluating the above Glueson code would result in:

```json
{
  "firstname": "John",
  "lastname": "Doe"
}
```

So bacically, whenever a value is an object and has an `_glueson`-Property, it is a dynamic expression that gets computed and then replaced by the result.

## purpose

gleson is not meant to be used as a general purpose programming language. Instead, it can act as "glue"-code (hence the name) to orchestrate other programs and pass arguments to them. It can fullfill a similar role to bash scripts and has the potential to be more efficient at it. glueson was specifically designed to be used with [Nix](https://nixos.org/) and it's module system.

## features

- evaluation of expressions is cached, two equal commands will only be executed once
- execution in one single process, where alternatives like bash start a new shell process per script
- so potentially faster and more memory efficient
- opens up interesting possibilities to create highly configurable "scripts" using nix-modules
- all parameters to glueson expressions can be other glueson expressions

## reference

### execute

Execute a command and replace this expression with the command's output

```json
{
  "_glueson": "execute",
  "command": "grep $searchTerm",
  "params": {
    "searchTerm": "Steve"
  },
  "stdin": "John Doe\nSteve Lee\nPaul Allen"
}
```

evaluates to `"Steve"`

#### command

The executable and arguments, separated by a space. If an argument starts with a $-sign, then the value is replaced with the value from the "params" object with the same name. Otherwise, the value is directly used.
Arguments must not be wrapped in quotes and must not contain whitespace. Instead, if an argument contains whitespace, add it as a param instead and reference it with a $-sign.

#### params

In addition to passing arguments directly inside the `command`, you can also specify parameters in an object and then reference them in the `command`. See at the example above to see how this works.

#### stdin

If present, gets written to STDIN of the last command. If it's not a string, it gets serialized to JSON automatically.

#### log

A boolean, that if set to true, logs the STDOUT & STDERR instead of returning it. Instead, it returns the exitCode. Defaults to false.

### parse

Replace this expresion with the parsed value of a given `input`.

```json
{
  "_glueson": "parse",
  "input": "{\"a\":1}"
}
```

#### input

The value to parse. Must be a string.

#### format

- `"json"` parse the input as json (default)
- `"glueson"` parse & execute the input as glueson

### serialize

Replace this expresion with the JSON-serialized value of a given `input`.

```json
{
  "_glueson": "serialize",
  "input": {
    "a": 1
  }
}
```

#### input

The value to serialize.

### get

Replace this expression with a value of a given `input` at a specific `path`.

```json
{
  "_glueson": "get",
  "path": "a.b",
  "input": {
    "a": {
      "b": {
        "c": "hello world"
      }
    }
  }
}
```

evaluates to

```json
{
  "c": "hello world"
}
```

#### path

The path of the value in the `input` object. If it's nested inside multiple objects, the property names are delimited by a `.`.

#### input

The input object the expression is evaluated against. It has to contain the given `path` or it will fail.

## license

MIT
