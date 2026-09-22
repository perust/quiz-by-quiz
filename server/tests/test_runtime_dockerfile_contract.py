import importlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "server" / "Dockerfile"


def _runtime_command() -> list[str]:
    text = DOCKERFILE.read_text(encoding="utf-8")
    match = re.search(r"^CMD\s+(\[.*\])$", text, flags=re.MULTILINE)
    assert match is not None, "runtime Dockerfile must declare a JSON-array CMD"
    command = json.loads(match.group(1))
    assert isinstance(command, list) and all(isinstance(part, str) for part in command)
    return command


def test_runtime_image_uses_an_importable_asgi_factory() -> None:
    command = _runtime_command()

    assert command[1] == "app.main:create_app"
    assert "--factory" in command
    assert "--no-access-log" in command
    assert command[command.index("--log-level") + 1] == "warning"

    module_name, separator, attribute_name = command[1].partition(":")
    assert separator and module_name and attribute_name
    target = getattr(importlib.import_module(module_name), attribute_name)
    assert callable(target)
