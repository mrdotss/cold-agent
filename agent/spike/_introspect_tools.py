#!/usr/bin/env python3
"""Introspect AgentCore managed Browser + Code Interpreter client APIs and the
strands_tools catalog, to build the FX (Task 4) and chart (Task 5) tools."""
import importlib
import inspect
import pkgutil


def dump(modname):
    try:
        m = importlib.import_module(modname)
    except Exception as e:
        print(f"{modname}: IMPORT ERR {type(e).__name__}: {e}")
        return None
    print(f"\n== {modname} ==  file={getattr(m, '__file__', '?')}")
    print("exports:", [a for a in dir(m) if not a.startswith("_")][:60])
    return m


def sig(obj, name):
    try:
        print(f"  {name}{inspect.signature(obj)}")
    except Exception as e:
        print(f"  {name}: sig n/a ({e})")


for mod in ("bedrock_agentcore.tools",
            "bedrock_agentcore.tools.browser_client",
            "bedrock_agentcore.tools.code_interpreter_client"):
    dump(mod)

try:
    from bedrock_agentcore.tools.browser_client import BrowserClient
    print("\nBrowserClient methods:", [a for a in dir(BrowserClient) if not a.startswith("_")])
    for m in ("start", "stop", "generate_ws_headers", "get_ws_headers", "navigate"):
        if hasattr(BrowserClient, m):
            sig(getattr(BrowserClient, m), f"BrowserClient.{m}")
except Exception as e:
    print("BrowserClient:", e)

try:
    from bedrock_agentcore.tools.browser_client import browser_session
    sig(browser_session, "browser_session")
except Exception as e:
    print("browser_session:", e)

try:
    from bedrock_agentcore.tools.code_interpreter_client import CodeInterpreter
    print("\nCodeInterpreter methods:", [a for a in dir(CodeInterpreter) if not a.startswith("_")])
    for m in ("start", "stop", "invoke", "execute"):
        if hasattr(CodeInterpreter, m):
            sig(getattr(CodeInterpreter, m), f"CodeInterpreter.{m}")
except Exception as e:
    print("CodeInterpreter:", e)

try:
    from bedrock_agentcore.tools.code_interpreter_client import code_session
    sig(code_session, "code_session")
except Exception as e:
    print("code_session:", e)

# strands_tools catalog: look for browser / code interpreter / python tools
try:
    import strands_tools
    print("\n== strands_tools submodules ==")
    names = [mi.name for mi in pkgutil.iter_modules(strands_tools.__path__)]
    print(names)
    for cand in ("browser", "use_browser", "code_interpreter", "python_repl", "use_aws"):
        if cand in names:
            print(f"  -> has {cand}")
except Exception as e:
    print("strands_tools:", e)
