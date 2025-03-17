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
  "command": "grep ${searchTerm}",
  "params": {
    "searchTerm": "Steve"
  },
  "stdin": "John Doe\nSteve Lee\nPaul Allen"
}
```

evaluates to `"Steve"`

#### command

The command to be executed. This used [Bun Shell](https://bun.sh/docs/runtime/shell) to execute. The syntax is very similar to bash.
Piping with `|` and also chaining with `&` works as you would expect. You can also reference environment variables with `$`.

#### params

In addition to passing arguments directly inside the `command`, you can also specify parameters in an object and then reference them in the `command`. See at the example above to see how this works.

#### stdin

A string that, if present, gets written to STDIN of the last command.

#### output

Defines how the output of the command should be treated,
Can be either `"string"`, `"json"` or `"glueson"`, defaults to `"string"`

- `"string"` takes the output as a string
- `"json"` parses the output as JSON
- `"glueson"` parses & evaluates the output as glueson

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
