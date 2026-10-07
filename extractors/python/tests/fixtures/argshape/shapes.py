"""Arg-shape fixture: same-name defs (discriminated ids), typed params,
*args/**kwargs, keyword-only params, and overload-shaped call sites."""


def render(template: str, opts: dict = None) -> str:
    return template


def render(template: str, opts: dict, mode: str) -> str:
    return template


def convert(value: str) -> str:
    return value


def convert(value: int) -> str:
    return str(value)


def send(first: str, second: str) -> str:
    return first + second


def send(*parts: str) -> str:
    return "".join(parts)


def connect(host: str, *, port: int = 5432, timeout: int = 30) -> None:
    return None


class Repo:
    def find(self, user_id: str) -> str:
        return user_id

    def find(self, user_id: str, depth: int) -> str:
        return user_id


class Auditor:
    def find(self, user_id: str) -> str:
        return user_id


def caller() -> None:
    render("t")
    render("t", {}, "fast")
    convert("abc")
    convert(42)
    send("a", "b")
    send(*parts)
    connect("db")
    connect("db", port=5433)
    repo = Repo()
    repo.find("u1")
    repo.find("u1", 2)


def shadowed(x: int) -> int:
    return x


def shadowed(x: int) -> int:
    return x + 1
