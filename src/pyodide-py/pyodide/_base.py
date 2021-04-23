"""
Source code analysis, transformation, compilation, execution.
"""

import ast
from copy import deepcopy
from io import StringIO
from textwrap import dedent
import tokenize
from types import CodeType
from typing import Any, Dict, Generator, List, Optional
import builtins


def open_url(url: str) -> StringIO:
    """
    Fetches a given URL

    Parameters
    ----------
    url : str
       URL to fetch

    Returns
    -------
    io.StringIO
        the contents of the URL.
    """
    from js import XMLHttpRequest

    req = XMLHttpRequest.new()
    req.open("GET", url, False)
    req.send(None)
    return StringIO(req.response)


def should_quiet(source: str) -> bool:
    """
    Should we suppress output?

    Returns ``True`` if the last nonwhitespace character of ``source`` is a
    semicolon.

    Examples
    --------
    >>> should_quiet('1 + 1')
    False
    >>> should_quiet('1 + 1 ;')
    True
    >>> should_quiet('1 + 1 # comment ;')
    False
    """
    # We need to wrap tokens in a buffer because:
    # "Tokenize requires one argument, readline, which must be
    # a callable object which provides the same interface as the
    # io.IOBase.readline() method of file objects"
    source_io = StringIO(source)
    tokens = list(tokenize.generate_tokens(source_io.readline))

    for token in reversed(tokens):
        if token.type in (
            tokenize.ENDMARKER,
            tokenize.NL,  # ignoring empty lines (\n\n)
            tokenize.NEWLINE,
            tokenize.COMMENT,
        ):
            continue
        return (token.type == tokenize.OP) and (token.string == ";")
    return False


def _last_assign_to_expr(mod: ast.Module):
    """
    Implementation of 'last_expr_or_assign' return_mode.
    It modify the supplyied AST module so that the last
    statement's value can be returned in 'last_expr' return_mode.
    """
    # Largely inspired from IPython:
    # https://github.com/ipython/ipython/blob/3587f5bb6c8570e7bbb06cf5f7e3bc9b9467355a/IPython/core/interactiveshell.py#L3229
    if not mod.body:
        return
    last_node = mod.body[-1]

    if isinstance(last_node, ast.Assign):
        # In this case there can be multiple targets as in `a = b = 1`.
        # We just take the first one.
        target = last_node.targets[0]
    elif isinstance(last_node, (ast.AugAssign, ast.AnnAssign)):
        target = last_node.target
    else:
        return
    if isinstance(target, ast.Name):
        last_node = ast.Expr(ast.Name(target.id, ast.Load()))
        mod.body.append(last_node)


class EvalCodeResultException(Exception):
    def __init__(self, v):
        super().__init__(v)
        self.value = v


builtins.___EvalCodeResultException = EvalCodeResultException  # type: ignore

_raise_template_ast = ast.parse("raise ___EvalCodeResultException(x)").body[0]


def _last_expr_to_raise(mod: ast.Module):
    if not mod.body:
        return
    last_node = mod.body[-1]
    if not isinstance(mod.body[-1], (ast.Expr, ast.Await)):
        return
    raise_expr = deepcopy(_raise_template_ast)
    raise_expr.exc.args[0] = last_node.value  # type: ignore
    mod.body[-1] = raise_expr


def parse_and_compile_gen(
    source: str,
    *,
    quiet_trailing_semicolon=True,
    filename="<exec>",
    return_mode: str = "last_expr",
    flags: int = 0x0,
) -> Generator[ast.Module, None, CodeType]:
    # handle mis-indented input from multi-line strings
    source = dedent(source)
    if quiet_trailing_semicolon and should_quiet(source):
        return_mode = "none"

    mod = ast.parse(source, filename=filename)
    yield mod  # Allow people to do further ast transformations if they like.

    if return_mode == "last_expr_or_assign":
        # If the last statement is a named assignment, add an extra
        # expression to the end with just the L-value so that we can
        # handle it with the last_expr code.
        _last_assign_to_expr(mod)

    # we extract last expression
    if return_mode.startswith("last_expr"):  # last_expr or last_expr_or_assign
        _last_expr_to_raise(mod)

    ast.fix_missing_locations(mod)
    return compile(mod, filename, "exec", flags=flags)


def parse_and_compile(
    source: str,
    *,
    return_mode: str = "last_expr",
    quiet_trailing_semicolon: bool = True,
    filename: str = "<exec>",
    flags: int = 0x0,
) -> CodeType:
    gen = parse_and_compile_gen(
        source,
        return_mode=return_mode,
        quiet_trailing_semicolon=quiet_trailing_semicolon,
        flags=flags,
        filename=filename,
    )
    try:
        next(gen)
        next(gen)
    except StopIteration as e:
        return e.value  # the code
    assert False


def eval_code(
    source: str,
    globals: Optional[Dict[str, Any]] = None,
    locals: Optional[Dict[str, Any]] = None,
    *,
    return_mode: str = "last_expr",
    quiet_trailing_semicolon: bool = True,
    filename: str = "<exec>",
    flags: int = 0x0,
) -> Any:
    """Runs a code string.

    Parameters
    ----------
    source
        the Python code to run.

    Returns
    -------
    If the last nonwhitespace character of ``source`` is a semicolon,
    return ``None``.
    If the last statement is an expression, return the
    result of the expression.
    Use the ``return_mode`` and ``quiet_trailing_semicolon`` parameters in the
    constructor to modify this default behavior.
    """
    code = parse_and_compile(
        source,
        return_mode=return_mode,
        quiet_trailing_semicolon=quiet_trailing_semicolon,
        filename=filename,
        flags=flags,
    )
    if code is None:
        return
    try:
        res = eval(code, globals, locals)
        if res is not None:
            raise RuntimeError(
                "Used eval_code with TOP_LEVEL_AWAIT. Use eval_code_async for this instead."
            )
    except EvalCodeResultException as e:
        # Final expression from code returns here
        return e.value


async def eval_code_async(
    source: str,
    globals: Optional[Dict[str, Any]] = None,
    locals: Optional[Dict[str, Any]] = None,
    *,
    return_mode: str = "last_expr",
    quiet_trailing_semicolon: bool = True,
    filename: str = "<exec>",
    flags: int = 0x0,
) -> Any:
    """Runs a code string asynchronously.

    Uses
    [PyCF_ALLOW_TOP_LEVEL_AWAIT](https://docs.python.org/3/library/ast.html#ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
    to compile the code.

    Parameters
    ----------
    source
        the Python source code to run.

    Returns
    -------
    If the last nonwhitespace character of ``source`` is a semicolon,
    return ``None``.
    If the last statement is an expression, return the
    result of the expression.
    Use the ``return_mode`` and ``quiet_trailing_semicolon`` parameters in the
    constructor to modify this default behavior.
    """
    flags = flags or ast.PyCF_ALLOW_TOP_LEVEL_AWAIT  # type: ignore
    code = parse_and_compile(
        source,
        return_mode=return_mode,
        quiet_trailing_semicolon=quiet_trailing_semicolon,
        filename=filename,
        flags=flags,
    )
    if code is None:
        return
    try:
        coroutine = eval(code, globals, locals)
        if coroutine:
            await coroutine
    except EvalCodeResultException as e:
        return e.value


def find_imports(source: str) -> List[str]:
    """
    Finds the imports in a string of code

    Parameters
    ----------
    source : str
       the Python code to run.

    Returns
    -------
    ``List[str]``
        A list of module names that are imported in the code.

    Examples
    --------
    >>> from pyodide import find_imports
    >>> code = "import numpy as np; import scipy.stats"
    >>> find_imports(code)
    ['numpy', 'scipy']
    """
    # handle mis-indented input from multi-line strings
    source = dedent(source)

    mod = ast.parse(source)
    imports = set()
    for node in ast.walk(mod):
        if isinstance(node, ast.Import):
            for name in node.names:
                node_name = name.name
                imports.add(node_name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            module_name = node.module
            if module_name is None:
                continue
            imports.add(module_name.split(".")[0])
    return list(sorted(imports))
