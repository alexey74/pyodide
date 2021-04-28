import ast
from asyncio import iscoroutine
from contextlib import redirect_stdout, redirect_stderr, _RedirectStream  # type: ignore
from pyodide._base import CodeRunner
from pyodide.console import repr_shorten, _InteractiveConsole as InteractiveConsole
import __main__
from js import sleep
import sys
import traceback


class WriteStream:
    """A utility class so we can specify our own handlers for writes to sdout, stderr"""

    def __init__(self, write_handler):
        self.write_handler = write_handler

    def write(self, text):
        self.write_handler(text)


class ReadStream:
    def __init__(self, read_handler):
        self.read_handler = read_handler

    def readline(self, n=-1):
        return self.read_handler(n)


class redirect_stdin(_RedirectStream):
    _stream = "stdin"


banner = InteractiveConsole.banner(None)

import re
import rlcompleter

match_nonwhite_space = re.compile("[^\\w\\d\\s.(]")
completer = rlcompleter.Completer(__main__.__dict__)


def pycomplete(source):
    revsource = source[::-1]
    match = match_nonwhite_space.search(revsource)
    if match:
        source = source[: -match.end()]
    completer.matches = []
    completer.complete(source, 0)
    return completer.matches


code_runner = CodeRunner(globals=__main__.__dict__, filename="<console>")


async def exec_code(
    code, syntax_check_passed, stdin_callback, stdout_callback, stderr_callback
):
    mod, last_expr = code_runner._split_and_compile(
        code, flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT  # type: ignore
    )
    syntax_check_passed()
    await sleep(0)
    with redirect_stdout(WriteStream(stdout_callback)), redirect_stderr(
        WriteStream(stderr_callback)
    ), redirect_stdin(ReadStream(stdin_callback)):
        # run first part
        if mod is not None:
            coro = eval(mod, code_runner.globals, code_runner.locals)
            if iscoroutine(coro):
                await coro

        # evaluate last expression
        if last_expr is not None:
            res = eval(last_expr, code_runner.globals, code_runner.locals)
            if iscoroutine(res):
                res = await res
            if res is not None:
                res = repr_shorten(res)
            return res


def format_last_exception():
    keep_frames = False
    kept_frames = 0
    # Try to trim out stack frames inside our code
    for (frame, _) in traceback.walk_tb(sys.last_traceback):
        keep_frames = keep_frames or frame.f_code.co_filename == "<console>"
        if keep_frames:
            kept_frames += 1
    return "".join(
        traceback.format_exception(
            sys.last_type, sys.last_value, sys.last_traceback, -kept_frames
        )
    )
